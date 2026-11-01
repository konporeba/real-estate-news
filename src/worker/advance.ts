// WORKER-SIDE. The scheduler's every-tick "advance" job: carries a week the operator set moving
// through the stages that follow, so nobody has to run `npm run generate` / `npm run visuals` by
// hand. Before this, a confirmed pick sat in "Writing copy" until someone did.
//
// It owns no stage logic. Each stage is the same `main(argv)` its npm command runs, targeted at
// one digest, so the advance job and a manual run can never disagree about what a stage does.
//
// Runs in plain Node, never in the Astro/workerd runtime (eslint.config.js enforces it).
import { resumeDigest, transitionDigest } from "@/lib/digest/run-state";
import type { ServiceClient } from "@/lib/supabase-service";
import { main as runCollect } from "@/worker/collect";
import { main as runGenerate } from "@/worker/generate";
import { main as runRank } from "@/worker/rank";
import { main as runVisuals } from "@/worker/visuals";
import type { DigestRun, DigestStatus } from "@/types";

/** A stage entrypoint: the npm command's own `main`, returning its exit code. */
export type StageMain = (argv: string[]) => Promise<number>;

export interface AdvanceStages {
  collect: StageMain;
  rank: StageMain;
  generate: StageMain;
  visuals: StageMain;
}

export const REAL_STAGES: AdvanceStages = {
  collect: runCollect,
  rank: runRank,
  generate: runGenerate,
  visuals: runVisuals,
};

/**
 * How recently a `collecting`/`ranking` week must have changed to be picked up. Those states are
 * also what a crashed run leaves behind; a week stuck in one for longer is a dead run (the
 * 2026-07-20 week sat in `ranking` for months), which the operator closes or deletes — resuming it
 * would spend money on an outdated week. `generating`/`rendering` are only ever entered by an
 * operator action (confirm, retry, edit), so they are picked up at any age.
 */
export const RECENT_WORK_MS = 6 * 60 * 60 * 1000;

/** The stage that moves a week out of each working status, and the flag that targets it. */
const STAGE_FOR: Partial<Record<DigestStatus, { stage: keyof AdvanceStages; argv: (d: DigestRun) => string[] }>> = {
  collecting: { stage: "collect", argv: (d) => [`--week=${d.window_start}`] },
  ranking: { stage: "rank", argv: (d) => [`--digest=${d.id}`] },
  generating: { stage: "generate", argv: (d) => [`--digest=${d.id}`] },
  rendering: { stage: "visuals", argv: (d) => [`--digest=${d.id}`] },
};

/** collecting → ranking → ready_for_selection is the longest chain; one spare step. */
const MAX_STEPS = 4;

/** Every week the job should carry forward now, oldest first. */
export async function findAdvanceable(client: ServiceClient, now: Date): Promise<DigestRun[]> {
  const recentSince = new Date(now.getTime() - RECENT_WORK_MS).toISOString();
  const { data, error } = await client
    .from("digest")
    .select("*")
    .or(`status.in.(generating,rendering),and(status.in.(collecting,ranking),updated_at.gte.${recentSince})`)
    .order("window_start", { ascending: true });
  if (error) throw new Error(`failed to read digests to advance: ${error.code}: ${error.message}`);
  return data;
}

export interface AdvanceOutcome {
  ok: boolean;
  /** The status the week ended on. */
  status: DigestStatus;
  error?: string;
}

/**
 * Run stages on one week until it reaches a status no stage moves (a human gate, `failed`, ...).
 *
 * A stage that throws, or returns without moving the week, leaves it in a working status that the
 * next tick would retry forever — so the week is moved to `failed` with the reason, where the
 * dashboard shows it and offers Retry. Exactly one attempt per operator action, never a loop.
 */
export async function advanceDigest(
  client: ServiceClient,
  digest: DigestRun,
  stages: AdvanceStages,
): Promise<AdvanceOutcome> {
  let current = digest;
  for (let step = 0; step < MAX_STEPS; step++) {
    const next = STAGE_FOR[current.status];
    if (!next)
      return { ok: current.status !== "failed", status: current.status, error: current.last_error ?? undefined };

    let problem: string | null = null;
    let exitCode: number | null = null;
    try {
      exitCode = await stages[next.stage](next.argv(current));
    } catch (error: unknown) {
      problem = `${next.stage} stopped: ${error instanceof Error ? error.message : String(error)}`;
    }

    const reread = await resumeDigest(client, current.id);
    if (!reread.ok) return { ok: false, status: current.status, error: reread.message };
    const before = current.status;
    current = reread.data;

    if (current.status === before) {
      problem ??= `${next.stage} exited ${String(exitCode)} without moving the week on from "${before}"`;
      const failed = await transitionDigest(client, current.id, "failed", { lastError: problem });
      return { ok: false, status: failed.ok ? "failed" : current.status, error: problem };
    }
  }
  return { ok: true, status: current.status };
}

/** The job's action: advance every eligible week; one week failing never stops the others. */
export async function runAdvance(
  client: ServiceClient,
  stages: AdvanceStages = REAL_STAGES,
  now: Date = new Date(),
  find: (client: ServiceClient, now: Date) => Promise<DigestRun[]> = findAdvanceable,
): Promise<{ ok: boolean; error?: string }> {
  const digests = await find(client, now);
  const problems: string[] = [];

  for (const digest of digests) {
    console.log(`[advance] week ${digest.window_start} (${digest.id}) is "${digest.status}" — running the next stage`);
    const outcome = await advanceDigest(client, digest, stages);
    console.log(`[advance] week ${digest.window_start} is now "${outcome.status}"`);
    if (!outcome.ok) problems.push(`week ${digest.window_start}: ${outcome.error ?? "failed"}`);
  }

  return problems.length === 0 ? { ok: true } : { ok: false, error: problems.join("; ") };
}
