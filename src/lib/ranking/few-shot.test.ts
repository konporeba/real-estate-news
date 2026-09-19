// Integration tests for the few-shot retrieval module (S-09/FR-025). Real database, because the
// guarantee under test — picked/passed split, most-recent-first ordering across real `selection`
// rows, and the per-label cap — is only meaningful against actual joined rows, mirroring
// rank.test.ts's approach for the same reason.
//
// Purged before EACH test (not just once), unlike rank.test.ts: fetchFewShotExamples deliberately
// reads across ALL digests (it is not scoped to one), so leftover rows from an earlier test in
// this file would otherwise leak into a later test's result.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { fetchFewShotExamples } from "@/lib/ranking/few-shot";
import type { GeographyTier } from "@/lib/ranking/score";
import { createDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const TEST_WINDOW_FIRST = "2995-01-01";
const TEST_WINDOW_LAST = "2995-12-31";

let weekIndex = 0;

function nextWeek(): { start: string; end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(2995, 0, 3 + offset))),
    end: iso(new Date(Date.UTC(2995, 0, 9 + offset))),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the integration suite`);
  return value;
}

function serviceClient() {
  return createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

async function purge(): Promise<void> {
  const { error } = await serviceClient()
    .from("digest")
    .delete()
    .gte("window_start", TEST_WINDOW_FIRST)
    .lte("window_start", TEST_WINDOW_LAST);
  if (error) throw new Error(`failed to purge test digests: ${error.message}`);
}

interface ItemSpec {
  title: string;
  tier: GeographyTier;
  rationale: string;
  picked: boolean;
  /** Defaults to true. false omits the article row (the skip-on-missing-representative case). */
  withArticle?: boolean;
  /** Defaults to true. false writes scoring_detail without a tier/rationale (skip case). */
  withScoringDetail?: boolean;
}

/** Creates a fresh digest, a confirmed selection on it at `confirmedAt`, and one selection_item
 *  (+ backing cluster/article) per spec — the minimum real rows fetchFewShotExamples reads. */
async function makeSelection(db: ServiceClient, confirmedAt: string, items: ItemSpec[]): Promise<{ digestId: string }> {
  const created = await createDigest(db, nextWeek());
  if (!created.ok) throw new Error(`${created.reason}: ${created.message}`);
  const digestId = created.data.id;

  const itemRows: { cluster_id: string; picked: boolean }[] = [];
  for (const item of items) {
    const scoringDetail =
      item.withScoringDetail === false ? {} : { tier: item.tier, score: 80, rationale: item.rationale, topics: [] };
    const { data: cluster, error: clusterError } = await db
      .from("cluster")
      .insert({ digest_id: digestId, coverage_count: 1, scoring_detail: scoringDetail })
      .select("id")
      .single();
    if (clusterError) throw new Error(clusterError.message);

    if (item.withArticle !== false) {
      const { error: articleError } = await db.from("article").insert({
        digest_id: digestId,
        cluster_id: cluster.id,
        source_name: "Test Source",
        source_url: `https://example.test/few-shot/${cluster.id}`,
        original_title: item.title,
        original_lede: `${item.title} lede`,
      });
      if (articleError) throw new Error(articleError.message);
    }

    itemRows.push({ cluster_id: cluster.id, picked: item.picked });
  }

  const { data: selection, error: selectionError } = await db
    .from("selection")
    .insert({ digest_id: digestId, format: "single_post", platforms: ["instagram"], confirmed_at: confirmedAt })
    .select("id")
    .single();
  if (selectionError) throw new Error(selectionError.message);

  const { error: itemsError } = await db
    .from("selection_item")
    .insert(itemRows.map((row) => ({ selection_id: selection.id, ...row })));
  if (itemsError) throw new Error(itemsError.message);

  return { digestId };
}

let db: ServiceClient;

describe.skipIf(!configured)("fetchFewShotExamples (integration)", () => {
  beforeEach(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("splits picked from passed, most-recently-confirmed first, capped per label", async () => {
    // Far-future confirmed_at: this suite runs against the real configured Supabase project
    // (SUPABASE_TEST_PROJECT=1), which already holds real production selections. A far-future
    // timestamp guarantees these synthetic rows sort ahead of any real one, regardless of how
    // much real history exists — the same reason rank.test.ts/rubric.eval.test.ts use far-future
    // digest windows.
    await makeSelection(db, "2995-01-01T00:00:00Z", [
      { title: "S1-pick", tier: "catalonia", rationale: "r-s1-pick", picked: true },
      { title: "S1-pass", tier: "national", rationale: "r-s1-pass", picked: false },
    ]);
    await makeSelection(db, "2995-06-01T00:00:00Z", [
      { title: "S2-pick", tier: "catalonia", rationale: "r-s2-pick", picked: true },
      { title: "S2-pass", tier: "national", rationale: "r-s2-pass", picked: false },
    ]);
    await makeSelection(db, "2995-12-01T00:00:00Z", [
      { title: "S3-pick", tier: "catalonia", rationale: "r-s3-pick", picked: true },
      { title: "S3-pass", tier: "national", rationale: "r-s3-pass", picked: false },
    ]);

    const result = await fetchFewShotExamples(db, { limitPerLabel: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // S1 is the oldest selection and its label is at the cap already reached by S2/S3 — excluded.
    expect(result.data.map((e) => e.title)).toEqual(["S3-pick", "S2-pick", "S3-pass", "S2-pass"]);
    expect(result.data.every((e) => e.rationale.length > 0)).toBe(true);
  });

  it("skips a selection_item whose article or scoring detail can't be resolved", async () => {
    await makeSelection(db, "2995-01-01T00:00:00Z", [
      { title: "has-everything", tier: "catalonia", rationale: "r-ok", picked: true },
      { title: "no-article", tier: "catalonia", rationale: "r-no-article", picked: true, withArticle: false },
      { title: "no-scoring-detail", tier: "catalonia", rationale: "r-none", picked: true, withScoringDetail: false },
    ]);

    // limitPerLabel matches the single valid fake PICKED item exactly, so that side of the cap is
    // saturated by the synthetic (dominant, far-future) data alone. This test creates no PASSED
    // item, so — unlike the picked side — real production "passed" rows can and do fill that
    // bucket; assert on the picked subset only, which is what this test is actually about.
    const result = await fetchFewShotExamples(db, { limitPerLabel: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.filter((e) => e.picked).map((e) => e.title)).toEqual(["has-everything"]);
    expect(result.data.map((e) => e.title)).not.toContain("no-article");
    expect(result.data.map((e) => e.title)).not.toContain("no-scoring-detail");
  });

  it("excludes the given digest id", async () => {
    const { digestId } = await makeSelection(db, "2995-01-01T00:00:00Z", [
      { title: "excluded-pick", tier: "catalonia", rationale: "r-excluded", picked: true },
    ]);
    await makeSelection(db, "2995-06-01T00:00:00Z", [
      { title: "included-pick", tier: "catalonia", rationale: "r-included", picked: true },
    ]);

    // limitPerLabel: 1, for the same saturation reason as the skip test above — with the excluded
    // digest's selection filtered out at the query level, "included-pick" is the only remaining
    // synthetic (dominant, far-future) picked candidate. As above, only the picked side is
    // saturated by fake data, so assert on that subset only.
    const result = await fetchFewShotExamples(db, { limitPerLabel: 1, excludeDigestId: digestId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.filter((e) => e.picked).map((e) => e.title)).toEqual(["included-pick"]);
    expect(result.data.map((e) => e.title)).not.toContain("excluded-pick");
  });
});
