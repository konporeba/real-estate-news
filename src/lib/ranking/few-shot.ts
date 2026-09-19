// WORKER-SIDE. S-09/FR-025: reads real selection_item history (S-04's picks-vs-passes labels)
// into the shape the ranking rubric's few-shot section needs.
//
// Follows this codebase's established join convention — separate queries, joined in application
// code via Maps — rather than Supabase embedded/nested selects. See
// src/pages/dashboard/[id].astro and src/lib/ranking/rank.ts for the same pattern.
import type { GeographyTier } from "@/lib/ranking/score";
import type { ServiceClient } from "@/lib/supabase-service";
import type { RunStateResult } from "@/types";

/** One past editorial decision, shaped for the rubric's few-shot section. */
export interface FewShotExample {
  title: string;
  lede: string | null;
  tier: GeographyTier;
  picked: boolean;
  rationale: string;
}

export interface FewShotOptions {
  /** How many picked and how many passed examples to return, at most (each label independently). */
  limitPerLabel: number;
  /** Excludes a selection for this digest — defensive; a digest still being ranked never has one
   *  yet, but this keeps the query correct if that assumption is ever violated. */
  excludeDigestId?: string;
}

// How many of the most-recently-confirmed selections to scan before returning what was found.
// Each selection yields MIN_PICKS-MAX_PICKS picks and (15 - picks) passes (FR-012/S-04), so a
// handful of selections comfortably covers the default limitPerLabel (8) for both labels — even
// at the worst case for the "picked" side (MIN_PICKS per selection), 20 selections yield up to
// 20 * MIN_PICKS picks, far above 8.
const SELECTION_LOOKBACK = 20;

function databaseFail(error: { code: string; message: string }): RunStateResult<never> {
  return { ok: false, reason: "database_error", message: `${error.code}: ${error.message}` };
}

interface ScoringDetail {
  tier?: GeographyTier;
  rationale?: string;
}

interface DatedExample extends FewShotExample {
  confirmedAt: string;
}

function toFewShotExample(example: DatedExample): FewShotExample {
  return {
    title: example.title,
    lede: example.lede,
    tier: example.tier,
    picked: example.picked,
    rationale: example.rationale,
  };
}

/**
 * Fetch a small, recent, capped sample of real picks and passes, joined back to each cluster's
 * representative article and stored rubric reasoning. Ordered most-recently-confirmed first;
 * picked examples are returned before passed ones.
 *
 * A selection_item whose representative article or scoring detail can't be resolved is skipped
 * rather than thrown — defensive only, since a confirmed selection's clusters always have both,
 * mirroring the flatMap/skip convention in dashboard/[id].astro.
 */
export async function fetchFewShotExamples(
  client: ServiceClient,
  options: FewShotOptions,
): Promise<RunStateResult<FewShotExample[]>> {
  let selectionQuery = client
    .from("selection")
    .select("id, digest_id, confirmed_at")
    .order("confirmed_at", { ascending: false })
    .limit(SELECTION_LOOKBACK);
  if (options.excludeDigestId) selectionQuery = selectionQuery.neq("digest_id", options.excludeDigestId);

  const { data: selections, error: selectionsError } = await selectionQuery;
  if (selectionsError) return databaseFail(selectionsError);
  if (selections.length === 0) return { ok: true, data: [] };

  const confirmedAtBySelection = new Map(selections.map((s) => [s.id, s.confirmed_at]));
  const selectionIds = selections.map((s) => s.id);

  const { data: items, error: itemsError } = await client
    .from("selection_item")
    .select("selection_id, cluster_id, picked")
    .in("selection_id", selectionIds);
  if (itemsError) return databaseFail(itemsError);
  if (items.length === 0) return { ok: true, data: [] };

  const clusterIds = items.map((item) => item.cluster_id);

  const { data: clusters, error: clustersError } = await client
    .from("cluster")
    .select("id, scoring_detail")
    .in("id", clusterIds);
  if (clustersError) return databaseFail(clustersError);

  const scoringDetailByCluster = new Map(clusters.map((c) => [c.id, c.scoring_detail as ScoringDetail | null]));

  const { data: articles, error: articlesError } = await client
    .from("article")
    .select("cluster_id, original_title, original_lede, polish_title")
    .in("cluster_id", clusterIds)
    .order("published_at", { ascending: true });
  if (articlesError) return databaseFail(articlesError);

  const articlesByCluster = new Map<string, NonNullable<typeof articles>>();
  for (const article of articles) {
    if (!article.cluster_id) continue;
    const list = articlesByCluster.get(article.cluster_id) ?? [];
    list.push(article);
    articlesByCluster.set(article.cluster_id, list);
  }

  const examples: DatedExample[] = [];
  for (const item of items) {
    const confirmedAt = confirmedAtBySelection.get(item.selection_id);
    const detail = scoringDetailByCluster.get(item.cluster_id);
    const clusterArticles = articlesByCluster.get(item.cluster_id) ?? [];
    const representative = clusterArticles.find((a) => a.polish_title) ?? clusterArticles.at(0);
    if (!confirmedAt || !detail?.tier || !detail.rationale || !representative) continue;

    examples.push({
      title: representative.original_title,
      lede: representative.original_lede,
      tier: detail.tier,
      picked: item.picked,
      rationale: detail.rationale,
      confirmedAt,
    });
  }

  examples.sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));

  const picked = examples.filter((e) => e.picked).slice(0, options.limitPerLabel);
  const passed = examples.filter((e) => !e.picked).slice(0, options.limitPerLabel);

  return { ok: true, data: [...picked, ...passed].map(toFewShotExample) };
}
