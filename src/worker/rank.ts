// WORKER-SIDE ENTRYPOINT. `npm run rank` — the manual trigger for the ranking stage (S-02), and
// the process the pipeline runs once S-01's collect() leaves a digest in `ranking`.
//
// Runs in plain Node, never in the Astro/workerd runtime. Nothing here (or anywhere under
// src/worker/ and src/lib/ranking/) may import astro:env/server or src/lib/supabase-admin;
// eslint.config.js enforces both directions of that boundary.
import { pathToFileURL } from "node:url";

import { createEmailClient, type EmailTransport } from "@/lib/email/client";
import { buildDigestReadyEmail, type DigestReadyItem } from "@/lib/email/digest-ready";
import { sendEmail } from "@/lib/email/send";
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

export interface ShortlistRow {
  id: string;
  rank: number;
  relevance_score: number | null;
  coverage_count: number;
  scoring_detail: { tier?: string } | null;
}

async function fetchShortlist(client: ServiceClient, digestId: string): Promise<ShortlistRow[]> {
  const { data, error } = await client
    .from("cluster")
    .select("id, rank, relevance_score, coverage_count, scoring_detail")
    .eq("digest_id", digestId)
    .not("rank", "is", null)
    .order("rank", { ascending: true });
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as ShortlistRow[];
}

/**
 * Join each shortlisted cluster to the article the operator will actually read, so the FR-010
 * email shows the same text the dashboard does. The representative rule is the one
 * src/pages/dashboard/[id].astro uses: whichever article carries a Polish translation (at most
 * one per cluster, per translateShortlist's scope), else the earliest published.
 */
async function fetchDigestReadyItems(
  client: ServiceClient,
  digestId: string,
  shortlist: ShortlistRow[],
): Promise<DigestReadyItem[]> {
  if (shortlist.length === 0) return [];

  const { data, error } = await client
    .from("article")
    .select("cluster_id, source_url, original_title, original_lede, polish_title, polish_summary")
    .in(
      "cluster_id",
      shortlist.map((row) => row.id),
    )
    .order("published_at", { ascending: true });
  if (error) throw new Error(`${error.code}: ${error.message}`);

  const byCluster = new Map<string, typeof data>();
  for (const article of data) {
    if (!article.cluster_id) continue;
    const list = byCluster.get(article.cluster_id) ?? [];
    list.push(article);
    byCluster.set(article.cluster_id, list);
  }

  return shortlist.flatMap((row): DigestReadyItem[] => {
    const articles = byCluster.get(row.id) ?? [];
    // .at(0) rather than [0]: an empty list is typed away by the index signature but is real.
    const representative = articles.find((a) => a.polish_title) ?? articles.at(0);
    // A shortlisted cluster with no articles cannot happen (clusters are built from articles),
    // but the email is not worth a crash if it ever does — drop the row instead.
    if (!representative) return [];
    return [
      {
        rank: row.rank,
        tier: row.scoring_detail?.tier ?? null,
        coverageCount: row.coverage_count,
        polishTitle: representative.polish_title,
        polishSummary: representative.polish_summary,
        originalTitle: representative.original_title,
        originalLede: representative.original_lede,
        sourceUrl: representative.source_url,
      },
    ];
  });
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

  const outcome = await rankDigest(llm, client, digest, {
    ceilingUsd: env.LLM_COST_CEILING_USD,
    fewShot: { enabled: env.RANKING_FEWSHOT_ENABLED, limitPerLabel: env.RANKING_FEWSHOT_LIMIT_PER_LABEL },
  });

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

  const transport = createEmailClient(
    env.GMAIL_USER && env.GMAIL_APP_PASSWORD ? { user: env.GMAIL_USER, appPassword: env.GMAIL_APP_PASSWORD } : null,
  );
  await notifyDigestReady(client, transport, digest, shortlist, {
    recipient: env.OPERATOR_EMAIL,
    baseUrl: env.DASHBOARD_BASE_URL,
  });
  return 0;
}

/**
 * FR-010: tell the operator the selection gate is open.
 *
 * Composed at the entrypoint rather than inside rankDigest(), mirroring how scheduled-run.ts
 * chains collect and rank: the ranking library stays free of side effects that aren't ranking.
 *
 * Never fails the run. Ranking has already succeeded and been persisted by this point, so a
 * missing credential or a refused SMTP connection must not turn a good digest into a failed job —
 * runCollectionJob() in scheduled-run.ts reads this function's exit code as the job's outcome.
 */
export async function notifyDigestReady(
  client: ServiceClient,
  transport: EmailTransport | null,
  digest: DigestRun,
  shortlist: ShortlistRow[],
  options: { recipient?: string; baseUrl?: string } = {},
): Promise<void> {
  // Every failure path below returns rather than throws. sendEmail() already promises never to
  // throw; the read and the build do not, so they are guarded here.
  let items: DigestReadyItem[];
  try {
    items = await fetchDigestReadyItems(client, digest.id, shortlist);
  } catch (error: unknown) {
    console.error(`digest-ready email skipped: could not read the shortlist articles: ${String(error)}`);
    return;
  }

  let request;
  try {
    request = buildDigestReadyEmail(digest, items, options.baseUrl);
  } catch (error: unknown) {
    console.error(`digest-ready email skipped: could not build the message: ${String(error)}`);
    return;
  }

  const result = await sendEmail(transport, options.recipient, request);

  if (result.ok) {
    console.log(`digest-ready email sent to ${options.recipient ?? "?"}`);
  } else if (result.reason === "not_configured") {
    console.log("digest-ready email not sent: email is not configured (GMAIL_USER/GMAIL_APP_PASSWORD/OPERATOR_EMAIL)");
  } else {
    console.error(`digest-ready email failed: ${result.reason}: ${result.message}`);
  }
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
