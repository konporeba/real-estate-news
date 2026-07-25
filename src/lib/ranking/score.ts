// WORKER-SIDE. The validated shape of a cluster's relevance score — the contract the rubric
// produces (S-02 Phase 2), the eval harness asserts on (Phase 1), and the orchestrator persists
// (Phase 4). It is the single source of truth for what "a score" is.
//
// The geography tier is the load-bearing field: FR-007 ranks by geography first, and the eval gate
// asserts on tier (not the exact number) because an LLM's numeric score jitters run to run while
// its tier judgment is stable. The numeric score orders within and across tiers; `scoring_detail`
// (jsonb) persists tier + topics + rationale that the numeric relevance_score column cannot hold.
import { z } from "zod";

/**
 * Geography tiers, most to least relevant (FR-007). The rule that matters: this is about where a
 * story's EFFECTS land, not where it was published — a national announcement made in Madrid is
 * `national`, not a discarded regional item.
 *
 * - `catalonia` — Barcelona/Catalonia: the editorial core, ranked highest
 * - `national`  — Spain-wide, nationally-applicable (mortgage rules, tax law, Bank of Spain data)
 * - `global`    — global items with direct Spanish market impact (ECB rates, EU property/residency law)
 * - `discard`   — other regions' purely local news, or off-topic; scored to be dropped
 */
export const GEOGRAPHY_TIERS = ["catalonia", "national", "global", "discard"] as const;
export type GeographyTier = (typeof GEOGRAPHY_TIERS)[number];

/**
 * The base 0–100 band each tier scores within, so tier and number never contradict. The rubric
 * places a cluster in a tier and then positions it inside the band by topic strength; the eval
 * asserts the tier, and ordering across tiers falls out of non-overlapping bands. Shared by the
 * rubric (to instruct the model) and the eval (to sanity-check tier↔score agreement).
 */
export const TIER_BANDS: Record<GeographyTier, { min: number; max: number }> = {
  catalonia: { min: 75, max: 100 },
  national: { min: 50, max: 74 },
  global: { min: 25, max: 49 },
  discard: { min: 0, max: 24 },
};

// No numeric or string-length constraints in the schema: F-03's toStructuredFormat rejects
// z.number().min()/max() and z.string().min() (the API cannot enforce them). The 0–100 range is
// validated in application code by assertScoreInRange after parsing.
export const clusterScoreSchema = z.object({
  tier: z.enum(GEOGRAPHY_TIERS),
  /** Topic tags driving the within-tier position (e.g. "rental-prices", "mortgage-rates"). */
  topics: z.array(z.string()),
  /** 0–100 relevance. Range-checked post-parse, not in the schema (see above). */
  score: z.number(),
  /** One-line editorial reasoning — aids rubric tuning and feeds S-09's learning loop. */
  rationale: z.string(),
});

export type ClusterScore = z.infer<typeof clusterScoreSchema>;

/** True when the score is a finite 0–100 value — the range the schema cannot assert. */
export function isScoreInRange(score: number): boolean {
  return Number.isFinite(score) && score >= 0 && score <= 100;
}

/**
 * Throw when a parsed score is out of the 0–100 range. Called after the schema validates shape, so
 * a model that returns a well-formed but nonsensical number (e.g. 250) fails loudly rather than
 * ranking against a bad value.
 */
export function assertScoreInRange(score: number): void {
  if (!isScoreInRange(score)) {
    throw new Error(`score ${score} is outside the valid 0–100 range`);
  }
}
