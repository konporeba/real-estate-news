// WORKER-SIDE ENTRYPOINT. `npm run scheduled-run` — invoked at any frequency (systemd
// timer, cron, or by hand); the due-check inside decides whether any work actually
// happens, so the invoker's own timing precision doesn't matter. Ties the scheduler core
// (src/lib/scheduler/) together with the real pipeline actions: today, the "collection"
// job runs collect.ts's main() and, only on success, rank.ts's main() next.
//
// Runs in plain Node, never in the Astro/workerd runtime. Nothing here may import
// astro:env/server or src/lib/supabase-admin; eslint.config.js enforces both directions
// of that boundary.
import { pathToFileURL } from "node:url";

import { SCHEDULED_JOBS, type ScheduledJobDefinition } from "@/lib/scheduler/registry";
import { isJobDue } from "@/lib/scheduler/schedule";
import { DEFAULT_STALE_AFTER_MS, getJobState, releaseJob, tryAcquireJob } from "@/lib/scheduler/store";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { main as runCollect } from "@/worker/collect";
import { loadWorkerEnv } from "@/worker/env";
import { main as runRank } from "@/worker/rank";
import type { ScheduledJobRow } from "@/types";

/** What a job's action reports back to the orchestrator. */
export interface JobOutcome {
  ok: boolean;
  error?: string;
}

export type JobAction = () => Promise<JobOutcome>;

async function runCollectionJob(): Promise<JobOutcome> {
  const collectExit = await runCollect();
  if (collectExit !== 0) return { ok: false, error: `collect exited ${collectExit}` };

  const rankExit = await runRank();
  if (rankExit !== 0) return { ok: false, error: `rank exited ${rankExit}` };

  return { ok: true };
}

/** Maps a job's registry name to the action that runs it for real. */
const JOB_ACTIONS: Record<string, JobAction> = {
  collection: runCollectionJob,
};

/** A freshly-claimed row always carries a `started_at`; narrows it without a non-null assertion. */
function requireStartedAt(row: ScheduledJobRow): string {
  if (row.started_at === null) {
    throw new Error(`claimed job "${row.name}" has no started_at — this should be unreachable`);
  }
  return row.started_at;
}

/**
 * Check every registered job for due-ness, claim and run whichever are due, and record
 * each outcome. Exported separately from `main()` so tests can drive it with fake actions
 * instead of the real (network- and LLM-spending) collect/rank chain.
 */
export async function runScheduledJobs(
  client: ServiceClient,
  jobs: readonly ScheduledJobDefinition[],
  actions: Record<string, JobAction>,
  now: Date,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): Promise<boolean> {
  let allOk = true;

  for (const job of jobs) {
    const stateResult = await getJobState(client, job.name);
    if (!stateResult.ok) {
      console.error(`[scheduled-run] ${job.name}: failed to read job state: ${stateResult.message}`);
      allOk = false;
      continue;
    }

    const lastFiredAt = stateResult.data?.last_fired_at ? new Date(stateResult.data.last_fired_at) : null;
    if (!isJobDue(job.schedule, lastFiredAt, now)) {
      console.log(`[scheduled-run] ${job.name}: not due`);
      continue;
    }

    const claim = await tryAcquireJob(client, job.name, now, staleAfterMs);
    if (!claim.ok) {
      console.log(`[scheduled-run] ${job.name}: due, but ${claim.reason} — skipping this cycle`);
      continue;
    }

    console.log(`[scheduled-run] ${job.name}: due, claimed — running`);
    const outcome = await actions[job.name]();

    const released = await releaseJob(client, job.name, requireStartedAt(claim.data), {
      completedAt: new Date(),
      error: outcome.ok ? null : (outcome.error ?? "job action failed"),
    });
    if (!released.ok) {
      console.error(`[scheduled-run] ${job.name}: failed to release claim: ${released.message}`);
    }

    if (outcome.ok) {
      console.log(`[scheduled-run] ${job.name}: succeeded`);
    } else {
      console.error(`[scheduled-run] ${job.name}: failed: ${outcome.error ?? "unknown error"}`);
      allOk = false;
    }
  }

  return allOk;
}

export async function main(now: Date = new Date()): Promise<number> {
  const env = loadWorkerEnv();
  const client = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const ok = await runScheduledJobs(client, SCHEDULED_JOBS, JOB_ACTIONS, now);
  return ok ? 0 : 1;
}

// Only run when executed directly, so the tests can import the helpers above.
// pathToFileURL rather than string concatenation: Windows paths (X:\...) do not form a
// valid file:// URL by prefixing, and this project is developed on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
