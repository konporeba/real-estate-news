// WORKER-SIDE. Scores clusters through F-03's invoke() with the geography rubric and a structured
// schema, batching several clusters per call to keep the call count (and thus ceiling exposure and
// the soft-ceiling concurrency overshoot) low.
//
// The soft ceiling (F-03 impl-review F1): invoke()'s check-then-account is not atomic, so the
// overshoot bound under concurrency is `concurrency × per-call cost`. BATCH_SIZE keeps per-call
// cost modest and MAX_CONCURRENCY keeps the multiplier small, so a whole pool stays well under the
// $5 ceiling. The rubric is a stable prefix passed with cacheSystem:true — repeat input at ~0.1x.
import { z } from "zod";

import type { LlmTransport } from "@/lib/llm/client";
import { invoke } from "@/lib/llm/invoke";
import { DEFAULT_MODEL } from "@/lib/llm/pricing";
import type { LabeledExample } from "@/lib/ranking/eval/harness";
import { buildScoringPrompt, GEOGRAPHY_RUBRIC_SYSTEM } from "@/lib/ranking/rubric";
import { assertScoreInRange, type ClusterScore, clusterScoreSchema } from "@/lib/ranking/score";
import type { ServiceClient } from "@/lib/supabase-service";
import type { LlmResult } from "@/types";

/** Clusters per scoring call, and how many calls run at once. Both bound ceiling exposure. */
const BATCH_SIZE = 12;
const MAX_CONCURRENCY = 3;
/** Output-token budget per cluster in a batch, plus a fixed floor — a score object is small. */
const MAX_TOKENS_PER_CLUSTER = 200;
const MAX_TOKENS_FLOOR = 400;

/** The input to scoring: a story (one or more articles' title+lede) with a stable local id. */
export interface ScorableCluster {
  id: string;
  articles: { title: string; lede: string | null }[];
}

// The batch response: one score per cluster, each echoing its clusterId so scores map back. Built
// from clusterScoreSchema's fields plus the id — no numeric/length constraints (F-03 rejects them).
const scoredClusterSchema = z.object({
  clusterId: z.string(),
  ...clusterScoreSchema.shape,
});
const batchScoreSchema = z.object({ scores: z.array(scoredClusterSchema) });

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run tasks with a bounded number in flight, preserving input order in the results. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Score every cluster, returning scores keyed by cluster id. Batches are scored concurrently; the
 * first batch that fails (ceiling, malformed, transport) short-circuits the whole result, since a
 * partial ranking is not useful and the orchestrator fails the digest on any error.
 *
 * A batch whose response omits a requested cluster — schema-valid but incomplete, which invoke's
 * reprompt cannot catch — is treated as `malformed_output` here: a missing score would silently
 * drop a story from the ranking.
 */
export async function scoreClusters(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  clusters: ScorableCluster[],
  options: { ceilingUsd: number },
): Promise<LlmResult<Map<string, ClusterScore>>> {
  if (clusters.length === 0) return { ok: true, data: new Map() };

  const batches = chunk(clusters, BATCH_SIZE);
  const batchResults = await mapWithConcurrency(batches, MAX_CONCURRENCY, (batch) =>
    scoreBatch(llm, db, digestId, batch, options),
  );

  const merged = new Map<string, ClusterScore>();
  for (const result of batchResults) {
    if (!result.ok) return result; // first failure wins (batch order)
    for (const [id, score] of result.data) merged.set(id, score);
  }

  // Completeness: every requested cluster must have a score.
  const missing = clusters.filter((c) => !merged.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "malformed_output",
      message: `scoring omitted ${missing.length} cluster(s): ${missing.join(", ")}`,
    };
  }

  return { ok: true, data: merged };
}

async function scoreBatch(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  batch: ScorableCluster[],
  options: { ceilingUsd: number },
): Promise<LlmResult<Map<string, ClusterScore>>> {
  const result = await invoke(
    llm,
    db,
    digestId,
    {
      model: DEFAULT_MODEL,
      system: GEOGRAPHY_RUBRIC_SYSTEM,
      cacheSystem: true,
      messages: [{ role: "user", content: buildScoringPrompt(batch) }],
      maxTokens: batch.length * MAX_TOKENS_PER_CLUSTER + MAX_TOKENS_FLOOR,
      schema: batchScoreSchema,
    },
    options,
  );
  if (!result.ok) return result;

  const scores = new Map<string, ClusterScore>();
  for (const scored of result.data.parsed.scores) {
    const { clusterId, ...score } = scored;
    assertScoreInRange(score.score); // schema can't range-check; a nonsensical number fails loudly
    scores.set(clusterId, score);
  }
  return { ok: true, data: scores };
}

/**
 * Score a single labeled example as a one-article cluster — the adapter the eval harness's Scorer
 * consumes, exercising the exact rubric path a real cluster takes. Throws on any scoring failure so
 * a misconfigured eval fails loudly rather than passing against nothing.
 */
export async function scoreExample(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  example: LabeledExample,
  ceilingUsd: number,
): Promise<ClusterScore> {
  const cluster: ScorableCluster = { id: example.id, articles: [{ title: example.title, lede: example.lede }] };
  const result = await scoreClusters(llm, db, digestId, [cluster], { ceilingUsd });
  if (!result.ok) throw new Error(`scoring failed: ${result.reason}: ${result.message}`);
  const score = result.data.get(example.id);
  if (!score) throw new Error(`no score returned for ${example.id}`);
  return score;
}
