// WORKER-SIDE ENTRYPOINT. `npm run collect` — the FR-018 manual trigger, and the process
// F-05 will later schedule for the automatic Sunday run.
//
// Runs in plain Node, never in the Astro/workerd runtime. Nothing here (or anywhere under
// src/worker/ and src/lib/collection/) may import astro:env/server or src/lib/supabase-admin;
// eslint.config.js enforces both directions of that boundary.
import { pathToFileURL } from "node:url";

import { collect } from "@/lib/collection/collect";
import { currentWeekWindow } from "@/lib/collection/window";
import { createDigest, getLatestRecoverableDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { loadWorkerEnv } from "@/worker/env";
import type { CollectionReport } from "@/lib/collection/report";
import type { DigestRun, RunStateResult } from "@/types";

/** `--week=YYYY-MM-DD` names the Monday of the week to target. */
const WEEK_FLAG = /^--week=(\d{4}-\d{2}-\d{2})$/;

export function parseWeekFlag(argv: string[]): string | null {
  for (const arg of argv) {
    const match = WEEK_FLAG.exec(arg);
    if (match) return match[1];
  }
  return null;
}

/** Thrown for an operator-facing refusal — printed without a stack trace. */
export class CollectRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectRefused";
  }
}

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.data;
}

/**
 * Resolve which digest this run works on.
 *
 * Order matters: an explicit `--week` wins, then the newest recoverable digest, and only
 * then the current calendar week. Putting recovery ahead of the calendar is what makes the
 * FR-018 re-trigger work with no flags — the operator who spots Sunday's failure on
 * Tuesday runs `npm run collect` and gets the failed run, not a fresh empty one.
 */
export async function resolveTargetDigest(
  client: ServiceClient,
  week: string | null,
  now: Date = new Date(),
): Promise<{ digest: DigestRun; origin: "flag" | "recovered" | "created" }> {
  if (week) {
    const existing = unwrap(await getLatestRecoverableDigestForWeek(client, week));
    if (existing) return { digest: existing, origin: "flag" };

    const created = await createDigest(client, { start: week, end: addDays(week, 6) });
    if (!created.ok) {
      throw new CollectRefused(
        created.reason === "active_digest_exists"
          ? `a digest for the week of ${week} exists but is past collection; nothing to do`
          : `${created.reason}: ${created.message}`,
      );
    }
    return { digest: created.data, origin: "flag" };
  }

  const recoverable = unwrap(await getLatestRecoverableDigest(client));
  if (recoverable) return { digest: recoverable, origin: "recovered" };

  const window = currentWeekWindow(now);
  return { digest: unwrap(await createDigest(client, window)), origin: "created" };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function getLatestRecoverableDigestForWeek(
  client: ServiceClient,
  week: string,
): Promise<RunStateResult<DigestRun | null>> {
  const { data, error } = await client
    .from("digest")
    .select("*")
    .eq("window_start", week)
    .not("status", "in", "(published,skipped)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { ok: false, reason: "database_error", message: `${error.code}: ${error.message}` };
  return { ok: true, data };
}

/**
 * Bring a resolved digest into a state the orchestrator can run against.
 *
 * `collecting` is passed through untouched — it is what a worker killed mid-run leaves
 * behind, the orchestrator's top-up insert is the correct recovery, and a self-transition
 * would be rejected by the state machine anyway.
 */
export async function prepareForCollection(client: ServiceClient, digest: DigestRun): Promise<DigestRun> {
  if (digest.status === "collecting") return digest;
  if (digest.status === "failed") return unwrap(await transitionDigest(client, digest.id, "collecting"));

  throw new CollectRefused(
    `digest ${digest.id} for the week of ${digest.window_start} is in "${digest.status}", past collection. ` +
      `Collection only runs on a digest in "collecting" or "failed".`,
  );
}

function summarize(report: CollectionReport): string {
  const lines = report.sources.map((source) => {
    const detail =
      source.status === "ok"
        ? `${source.itemsInserted} new / ${source.itemsFetched} fetched (${source.durationMs}ms)`
        : source.status === "skipped"
          ? "not attempted (pool was healthy)"
          : (source.error ?? "failed");
    return `  ${source.status.padEnd(7)} ${source.slug.padEnd(28)} ${detail}`;
  });

  return [
    `window  ${report.window.from} -> ${report.window.to}`,
    ...lines,
    `pool    ${report.poolSize} article(s)${report.thresholdMet ? "" : " — BELOW THRESHOLD"}`,
    report.fallbacksRan ? "fallback sources were escalated to" : "fallback sources not needed",
  ].join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const env = loadWorkerEnv();
  const client = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const week = parseWeekFlag(argv);
  const { digest, origin } = await resolveTargetDigest(client, week);

  // Printed before any work starts: the operator must be able to see the run targeted the
  // week they meant, especially when the default recovered an older one.
  console.log(
    `collecting for week ${digest.window_start} -> ${digest.window_end} ` +
      `(${origin}, status "${digest.status}", id ${digest.id})`,
  );

  const ready = await prepareForCollection(client, digest);
  const outcome = await collect(client, ready);

  if (!outcome.ok) {
    console.error(`collection failed: ${outcome.reason}: ${outcome.message}`);
    return 1;
  }

  console.log(summarize(outcome.data.report));
  console.log(`digest is now "${outcome.data.digest.status}"`);

  if (outcome.data.digest.status === "failed") {
    console.error(outcome.data.digest.last_error ?? "collection produced no articles");
    return 1;
  }
  return 0;
}

// Only run when executed directly, so the tests can import the helpers above.
// pathToFileURL rather than string concatenation: Windows paths (X:\...) do not form a
// valid file:// URL by prefixing, and this project is developed on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof CollectRefused) {
        console.error(error.message);
        process.exit(2);
      }
      console.error(error);
      process.exit(1);
    });
}
