// Integration tests for the every-tick advance job. Fake stages stand in for collect / rank /
// generate / visuals (the real ones fetch feeds and spend LLM money); each fake moves the digest
// the way its real stage does, so the job's chaining and failure handling run against the real
// state machine.
//
// SAFETY: findAdvanceable is global by nature, so these tests only ever hand runAdvance a finder
// restricted to their own synthetic weeks in 2998 — a fake stage must never run against a real
// week — and the purge only deletes that range.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { advanceDigest, findAdvanceable, RECENT_WORK_MS, runAdvance, type AdvanceStages } from "@/worker/advance";
import type { DigestRun, DigestStatus, RunStateResult } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const SYNTHETIC_FIRST = "2998-01-01";
const SYNTHETIC_LAST = "2998-12-31";

let weekIndex = 0;
function nextWeek(): { start: string; end: string } {
  const start = Date.UTC(2998, 0, 5) + weekIndex * 7 * 86_400_000; // 2998-01-05 is a Monday
  weekIndex += 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: iso(start), end: iso(start + 6 * 86_400_000) };
}

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.data;
}

let db: ServiceClient;

async function purgeSynthetic(): Promise<void> {
  const { error } = await db
    .from("digest")
    .delete()
    .gte("window_start", SYNTHETIC_FIRST)
    .lte("window_start", SYNTHETIC_LAST);
  if (error) throw new Error(`failed to purge synthetic digests: ${error.message}`);
}

/** A synthetic digest walked through the real state machine to `status`. */
async function digestIn(status: DigestStatus): Promise<DigestRun> {
  const path: Record<string, DigestStatus[]> = {
    collecting: [],
    ranking: ["ranking"],
    ready_for_selection: ["ranking", "ready_for_selection"],
    generating: ["ranking", "ready_for_selection", "generating"],
    rendering: ["ranking", "ready_for_selection", "generating", "rendering"],
  };
  let digest = unwrap(await createDigest(db, nextWeek()));
  for (const to of path[status]) digest = unwrap(await transitionDigest(db, digest.id, to));
  return digest;
}

/** Fake stages that move the digest named in argv exactly as the real stage would on success. */
function fakeStages(overrides: Partial<AdvanceStages> = {}): { stages: AdvanceStages; calls: string[] } {
  const calls: string[] = [];
  const moveById = (stage: string, to: DigestStatus) => async (argv: string[]) => {
    calls.push(`${stage} ${argv.join(" ")}`);
    const id = argv.find((a) => a.startsWith("--digest="))?.slice("--digest=".length);
    if (!id) throw new Error(`${stage} called without --digest`);
    unwrap(await transitionDigest(db, id, to));
    return 0;
  };
  const collect = async (argv: string[]) => {
    calls.push(`collect ${argv.join(" ")}`);
    const week = argv.find((a) => a.startsWith("--week="))?.slice("--week=".length);
    const { data } = await db
      .from("digest")
      .select("id")
      .eq("window_start", week ?? "")
      .single();
    if (!data) throw new Error("collect: no digest for that week");
    unwrap(await transitionDigest(db, data.id, "ranking"));
    return 0;
  };
  return {
    calls,
    stages: {
      collect,
      rank: moveById("rank", "ready_for_selection"),
      generate: moveById("generate", "rendering"),
      visuals: moveById("visuals", "ready_for_approval"),
      ...overrides,
    },
  };
}

describe.skipIf(!configured)("advance job (integration)", () => {
  beforeAll(async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    db = createServiceClient(url, key);
    await purgeSynthetic();
  });
  afterAll(async () => {
    await purgeSynthetic();
  });

  it("finds weeks waiting on writing or slides at any age, and only recent collection/ranking", async () => {
    const generating = await digestIn("generating");
    const recentRanking = await digestIn("ranking");
    const atGate = await digestIn("ready_for_selection");
    // A dead run: a ranking week nobody has touched for longer than RECENT_WORK_MS. Inserted
    // rather than transitioned, so updated_at can be set in the past.
    const week = nextWeek();
    const { data: stale } = await db
      .from("digest")
      .insert({
        window_start: week.start,
        window_end: week.end,
        status: "ranking",
        updated_at: new Date(Date.now() - RECENT_WORK_MS - 60_000).toISOString(),
      })
      .select()
      .single();

    const found = (await findAdvanceable(db, new Date())).map((d) => d.id);

    expect(found).toContain(generating.id);
    expect(found).toContain(recentRanking.id);
    expect(found).not.toContain(atGate.id);
    expect(found).not.toContain(stale?.id);
  });

  it("carries a confirmed week through writing and slides to the approval gate", async () => {
    const digest = await digestIn("generating");
    const { stages, calls } = fakeStages();

    const outcome = await advanceDigest(db, digest, stages);

    expect(outcome).toEqual({ ok: true, status: "ready_for_approval" });
    expect(calls).toEqual([`generate --digest=${digest.id}`, `visuals --digest=${digest.id}`]);
  });

  it("collects a retried week by its week, then ranks it, and stops at story selection", async () => {
    const digest = await digestIn("collecting");
    const { stages, calls } = fakeStages();

    const outcome = await advanceDigest(db, digest, stages);

    expect(outcome.status).toBe("ready_for_selection");
    expect(calls).toEqual([`collect --week=${digest.window_start}`, `rank --digest=${digest.id}`]);
  });

  it("marks the week failed when a stage throws, so the next tick does not retry it forever", async () => {
    const digest = await digestIn("rendering");
    const { stages } = fakeStages({
      visuals: () => Promise.reject(new Error("Slides API unreachable")),
    });

    const outcome = await advanceDigest(db, digest, stages);

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("failed");
    const { data } = await db.from("digest").select("status, last_error").eq("id", digest.id).single();
    expect(data?.status).toBe("failed");
    expect(data?.last_error).toContain("Slides API unreachable");
  });

  it("marks the week failed when a stage returns without moving it on", async () => {
    const digest = await digestIn("generating");
    const { stages } = fakeStages({ generate: () => Promise.resolve(1) });

    const outcome = await advanceDigest(db, digest, stages);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/generate exited 1/);
  });

  it("reports a stage's own failure without overwriting the reason it recorded", async () => {
    const digest = await digestIn("generating");
    const { stages } = fakeStages({
      generate: async (argv) => {
        const id = argv[0].slice("--digest=".length);
        unwrap(await transitionDigest(db, id, "failed", { lastError: "only 1 of 3 stories could be generated" }));
        return 1;
      },
    });

    const outcome = await advanceDigest(db, digest, stages);

    expect(outcome).toEqual({ ok: false, status: "failed", error: "only 1 of 3 stories could be generated" });
  });

  it("keeps going after one week fails, and names it in the job error", async () => {
    await purgeSynthetic();
    const broken = await digestIn("rendering");
    const fine = await digestIn("generating");
    const { stages } = fakeStages({
      visuals: async (argv) => {
        const id = argv[0].slice("--digest=".length);
        if (id === broken.id) throw new Error("boom");
        unwrap(await transitionDigest(db, id, "ready_for_approval"));
        return 0;
      },
    });
    const syntheticOnly = async (client: ServiceClient, now: Date) =>
      (await findAdvanceable(client, now)).filter(
        (d) => d.window_start >= SYNTHETIC_FIRST && d.window_start <= SYNTHETIC_LAST,
      );

    const result = await runAdvance(db, stages, new Date(), syntheticOnly);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(broken.window_start);
    const { data } = await db.from("digest").select("status").eq("id", fine.id).single();
    expect(data?.status).toBe("ready_for_approval");
  });
});
