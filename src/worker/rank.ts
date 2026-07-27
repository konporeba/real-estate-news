// WORKER-SIDE ENTRYPOINT. `npm run rank` — the manual trigger for the ranking stage (S-02), and
// the process the pipeline runs once S-01's collect() leaves a digest in `ranking`.
//
// Runs in plain Node, never in the Astro/workerd runtime. Nothing here (or anywhere under
// src/worker/ and src/lib/ranking/) may import astro:env/server or src/lib/supabase-admin;
// eslint.config.js enforces both directions of that boundary.
import { pathToFileURL } from "node:url";

import { createLlmClient } from "@/lib/llm/client";
import { resumeDigest } from "@/lib/digest/run-state";
import { rankDigest } from "@/lib/ranking/rank";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { loadWorkerEnv } from "@/worker/env";
import type { DigestRun, RunStateResult } from "@/types";

/** `--digest=<uuid>` names a specific digest to rank, bypassing the newest-in-`ranking` default. */
const DIGEST_FLAG = /^--digest=(.+)$/;

export function parseDigestFlag(argv: string[]): string | null {
  for (const arg of argv) {
    const match = DIGEST_FLAG.exec(arg);
    if (match) return match[1];
  }
  return null;
}

/** Thrown for an operator-facing refusal — printed without a stack trace. */
export class RankRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RankRefused";
  }
}

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.data;
}

async function newestInRanking(client: ServiceClient): Promise<DigestRun | null> {
  const { data, error } = await client
    .from("digest")
    .select("*")
    .eq("status", "ranking")
    .order("window_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data;
}

/**
 * Resolve which digest this run works on.
 *
 * An explicit `--digest` wins, and must already be in `ranking` — naming one mid-selection or
 * still collecting is a caller mistake, not something to silently fix. Absent a flag, the default
 * is the newest digest in `ranking`, the state S-01's collect() leaves a non-empty pool in.
 */
export async function resolveTargetDigest(client: ServiceClient, digestId: string | null): Promise<DigestRun> {
  if (digestId) {
    const digest = unwrap(await resumeDigest(client, digestId));
    if (digest.status !== "ranking") {
      throw new RankRefused(
        `digest ${digestId} is in "${digest.status}", not "ranking". Ranking only runs on a digest in "ranking".`,
      );
    }
    return digest;
  }

  const digest = await newestInRanking(client);
  if (!digest) {
    throw new RankRefused('no digest is in "ranking" — run collection first (npm run collect)');
  }
  return digest;
}

interface ShortlistRow {
  rank: number;
  relevance_score: number | null;
  coverage_count: number;
  scoring_detail: { tier?: string } | null;
}

async function fetchShortlist(client: ServiceClient, digestId: string): Promise<ShortlistRow[]> {
  const { data, error } = await client
    .from("cluster")
    .select("rank, relevance_score, coverage_count, scoring_detail")
    .eq("digest_id", digestId)
    .not("rank", "is", null)
    .order("rank", { ascending: true });
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as ShortlistRow[];
}

function summarize(rows: ShortlistRow[]): string {
  return rows
    .map((row) => {
      const tier = row.scoring_detail?.tier ?? "?";
      return `  #${String(row.rank).padStart(2)}  ${tier.padEnd(10)} score=${row.relevance_score ?? "?"}  coverage=${row.coverage_count}`;
    })
    .join("\n");
}

// Clustering is a single invoke() call over the WHOLE article pool (up to a few hundred
// articles), generating a full grouping as one completion — a real run measured this exceeding
// the SDK's 60s default (src/lib/llm/client.ts). Per that file's own guidance, the fix is a
// longer timeout, not more retries: worst-case wall clock per call is timeoutMs × (maxRetries+1),
// which is an acceptable trade for an unattended weekly job.
const LLM_TIMEOUT_MS = 5 * 60_000;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const env = loadWorkerEnv();
  const client = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const llm = createLlmClient(env.ANTHROPIC_API_KEY, { timeoutMs: LLM_TIMEOUT_MS });

  const digest = await resolveTargetDigest(client, parseDigestFlag(argv));

  // Printed before any work starts, mirroring collect.ts: the operator must see the run
  // targeted the digest they meant before any spend happens.
  console.log(`ranking digest ${digest.id} for week ${digest.window_start} -> ${digest.window_end}`);

  const outcome = await rankDigest(llm, client, digest, { ceilingUsd: env.LLM_COST_CEILING_USD });

  if (!outcome.ok) {
    console.error(`ranking did not complete: ${outcome.reason}: ${outcome.message}`);
    return 1;
  }

  console.log(`digest is now "${outcome.data.digest.status}" (cost $${outcome.data.digest.cost_usd})`);

  if (outcome.data.digest.status === "failed") {
    console.error(outcome.data.digest.last_error ?? "ranking failed with no recorded reason");
    return 1;
  }

  const shortlist = await fetchShortlist(client, digest.id);
  console.log(`shortlist (${shortlist.length} of ${outcome.data.clusterCount} clusters):`);
  console.log(summarize(shortlist));
  return 0;
}

// Only run when executed directly, so the tests can import the helpers above.
// pathToFileURL rather than string concatenation: Windows paths (X:\...) do not form a
// valid file:// URL by prefixing, and this project is developed on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof RankRefused) {
        console.error(error.message);
        process.exit(2);
      }
      console.error(error);
      process.exit(1);
    });
}
