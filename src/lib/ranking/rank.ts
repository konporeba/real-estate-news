// WORKER-SIDE. The ranking stage: everything between "a digest exists in `ranking`" and "the
// digest is in `ready_for_selection` or `failed`". Composes clustering (Phase 3), scoring
// (Phase 2), and ordering (Phase 4) into one stage, persists the result, and transitions the
// digest — mirroring the collection stage's orchestrator (`src/lib/collection/collect.ts`).
//
// Convention shared with collect(): an infrastructure-level failure (a Postgres error mid-run)
// is returned raw so the caller sees it as a stage that did not run to completion. A GENUINE
// failure — empty pool, clustering/scoring came back empty, or an LLM error including a ceiling
// hit — is instead handled by transitioning the digest to `failed` with a diagnostic in
// `last_error`, and the function still returns `ok: true`: the stage ran to completion, it just
// concluded the digest cannot proceed. Callers check `outcome.data.digest.status` to tell the two
// apart, exactly as `src/worker/collect.ts` does.
import { clusterArticles, type ClusterableArticle } from "@/lib/ranking/cluster";
import { orderClusters, type ScoredCluster } from "@/lib/ranking/rank-order";
import { scoreClusters, type ScorableCluster } from "@/lib/ranking/score-clusters";
import { markStageComplete, transitionDigest } from "@/lib/digest/run-state";
import type { LlmTransport } from "@/lib/llm/client";
import type { ServiceClient } from "@/lib/supabase-service";
import type { ClusterScore } from "@/lib/ranking/score";
import type { DigestRun, RunStateResult } from "@/types";

/** Clusters ranked 1..N carry the shortlist; the rest are persisted with `rank` null. */
const SHORTLIST_SIZE = 15;

export interface RankOptions {
  ceilingUsd: number;
}

export interface RankOutcome {
  digest: DigestRun;
  /** Clusters persisted this run. 0 when the stage concluded in `failed` before persisting. */
  clusterCount: number;
}

interface ArticleRow {
  id: string;
  original_title: string;
  original_lede: string | null;
}

function databaseFail(error: { code: string; message: string }): RunStateResult<never> {
  return { ok: false, reason: "database_error", message: `${error.code}: ${error.message}` };
}

async function fetchPool(client: ServiceClient, digestId: string): Promise<RunStateResult<ArticleRow[]>> {
  const { data, error } = await client
    .from("article")
    .select("id, original_title, original_lede")
    .eq("digest_id", digestId);
  if (error) return databaseFail(error);
  return { ok: true, data };
}

/**
 * Clustering is not idempotent, so a re-run (a worker restarted mid-`ranking`) reclusters from
 * scratch rather than appending to whatever a prior attempt persisted. `article.cluster_id` is
 * `on delete set null`, so clearing `cluster` rows detaches their articles for free.
 */
async function clearExistingClusters(client: ServiceClient, digestId: string): Promise<RunStateResult<void>> {
  const { error } = await client.from("cluster").delete().eq("digest_id", digestId);
  if (error) return databaseFail(error);
  return { ok: true, data: undefined };
}

interface PersistedCluster {
  id: string;
  articleIds: string[];
}

/**
 * Insert one `cluster` row per group and assign each group's articles to it.
 *
 * The article assignment is one `assign_articles_to_clusters` RPC call for the whole pool, not
 * one `.update()` per cluster — a real ~368-article pool produces on the order of 250 clusters,
 * and a per-cluster loop there was ~250 sequential round trips for what is really one bulk
 * write. PostgREST's `.upsert()` can't express this: it's typed against the table's full
 * `Insert` shape, which demands every NOT NULL column even though every one of these ids already
 * exists and only `cluster_id` is changing — the same "PostgREST can't express it, so make it a
 * function" precedent as `increment_digest_cost` (F-03). See
 * `supabase/migrations/20260727150000_bulk_ranking_writes.sql`.
 */
async function persistClusters(
  client: ServiceClient,
  digestId: string,
  clusters: { articleIds: string[] }[],
): Promise<RunStateResult<PersistedCluster[]>> {
  const rows = clusters.map((c) => ({ digest_id: digestId, coverage_count: c.articleIds.length }));
  const { data, error } = await client.from("cluster").insert(rows).select("id");
  if (error) return databaseFail(error);

  const persisted: PersistedCluster[] = clusters.map((c, index) => ({ id: data[index].id, articleIds: c.articleIds }));

  const articleIds: string[] = [];
  const clusterIds: string[] = [];
  for (const cluster of persisted) {
    for (const articleId of cluster.articleIds) {
      articleIds.push(articleId);
      clusterIds.push(cluster.id);
    }
  }
  if (articleIds.length > 0) {
    const { error: assignError } = await client.rpc("assign_articles_to_clusters", {
      p_article_ids: articleIds,
      p_cluster_ids: clusterIds,
    });
    if (assignError) return databaseFail(assignError);
  }

  return { ok: true, data: persisted };
}

/**
 * Write the score, detail, and shortlist rank onto every already-persisted cluster row in one
 * `persist_cluster_rankings` RPC call, for the same reason `persistClusters` batches its article
 * assignment above.
 */
async function persistRanking(
  client: ServiceClient,
  clusters: { id: string; score: number; detail: ClusterScore; rank: number | null }[],
): Promise<RunStateResult<void>> {
  if (clusters.length === 0) return { ok: true, data: undefined };
  const { error } = await client.rpc("persist_cluster_rankings", {
    p_cluster_ids: clusters.map((c) => c.id),
    p_scores: clusters.map((c) => c.score),
    p_details: clusters.map((c) => c.detail),
    p_ranks: clusters.map((c) => c.rank),
  });
  if (error) return databaseFail(error);
  return { ok: true, data: undefined };
}

/** The genuine-failure path: transition to `failed` with a diagnostic, but return `ok: true` — the
 *  stage ran to completion, it just concluded the digest cannot proceed (see file header). */
async function failDigest(
  client: ServiceClient,
  digestId: string,
  message: string,
): Promise<RunStateResult<RankOutcome>> {
  const failed = await transitionDigest(client, digestId, "failed", { lastError: message });
  if (!failed.ok) return failed;
  return { ok: true, data: { digest: failed.data, clusterCount: 0 } };
}

/**
 * Run ranking for a digest that is in `ranking`. Assumes the caller (the worker entrypoint,
 * Phase 5) has already checked the digest's status — this function does not re-check it, the same
 * split of responsibility `collect()` uses with `prepareForCollection`.
 */
export async function rankDigest(
  llm: LlmTransport | null,
  client: ServiceClient,
  digest: DigestRun,
  options: RankOptions,
): Promise<RunStateResult<RankOutcome>> {
  const pool = await fetchPool(client, digest.id);
  if (!pool.ok) return pool;

  if (pool.data.length === 0) {
    return failDigest(client, digest.id, "the article pool is empty; nothing to rank");
  }

  const cleared = await clearExistingClusters(client, digest.id);
  if (!cleared.ok) return cleared;

  const clusterable: ClusterableArticle[] = pool.data.map((a) => ({
    id: a.id,
    title: a.original_title,
    lede: a.original_lede,
  }));

  const clustered = await clusterArticles(llm, client, digest.id, clusterable, options);
  if (!clustered.ok) {
    return failDigest(client, digest.id, `clustering ${clustered.reason}: ${clustered.message}`);
  }
  if (clustered.data.length === 0) {
    return failDigest(client, digest.id, "clustering produced no clusters");
  }

  const persisted = await persistClusters(client, digest.id, clustered.data);
  if (!persisted.ok) return persisted;

  const byId = new Map(pool.data.map((a) => [a.id, a]));
  const scorable: ScorableCluster[] = persisted.data.map((c) => ({
    id: c.id,
    articles: c.articleIds.map((id) => {
      const article = byId.get(id);
      if (!article) throw new Error(`clustering referenced unknown article id ${id}`);
      return { title: article.original_title, lede: article.original_lede };
    }),
  }));

  const scored = await scoreClusters(llm, client, digest.id, scorable, options);
  if (!scored.ok) {
    return failDigest(client, digest.id, `scoring ${scored.reason}: ${scored.message}`);
  }

  const scoredClusters: (ScoredCluster & { detail: ClusterScore })[] = persisted.data.map((c) => {
    const detail = scored.data.get(c.id);
    if (!detail) throw new Error(`no score returned for cluster ${c.id}`);
    return { id: c.id, score: detail.score, coverageCount: c.articleIds.length, detail };
  });

  const ordered = orderClusters(scoredClusters);

  const rankingRows = ordered.map((cluster, index) => ({
    id: cluster.id,
    score: cluster.score,
    detail: cluster.detail,
    rank: index < SHORTLIST_SIZE ? index + 1 : null,
  }));
  const written = await persistRanking(client, rankingRows);
  if (!written.ok) return written;

  const checkpointed = await markStageComplete(client, digest.id, "ranking");
  if (!checkpointed.ok) return checkpointed;

  const transitioned = await transitionDigest(client, digest.id, "ready_for_selection");
  if (!transitioned.ok) return transitioned;

  return { ok: true, data: { digest: transitioned.data, clusterCount: ordered.length } };
}
