// The pure ordering function the ranking orchestrator (Phase 4) applies after scoring: rank by
// relevance score, breaking only a NEAR tie by coverage count. Geography stays primary (FR-007);
// coverage only nudges within a tier (FR-005/US-07), it never overrides a clear score gap.
//
// Testable without the DB or an LLM — everything here is synchronous over already-scored data.

/** What ordering needs from a scored cluster. Extra fields on `T` pass through untouched. */
export interface ScoredCluster {
  id: string;
  score: number;
  coverageCount: number;
}

/**
 * Scores within this many points of each other are a near-tie, broken by coverage instead of the
 * raw score. Kept well inside a single geography tier's band (25 points wide, `TIER_BANDS` in
 * `score.ts`) so this never reorders across tiers — only nudges within one.
 */
const TIE_BAND = 3;

/**
 * Order clusters by relevance score (desc), breaking a near-tie (within `TIE_BAND`) by coverage
 * count (desc). A gap larger than the band always wins on score alone, so coverage cannot promote
 * a weak-geography story over a strong one — it only decides between stories the rubric already
 * considers roughly equal.
 */
export function orderClusters<T extends ScoredCluster>(clusters: T[]): T[] {
  return [...clusters].sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) <= TIE_BAND) {
      const coverageDiff = b.coverageCount - a.coverageCount;
      if (coverageDiff !== 0) return coverageDiff;
    }
    return scoreDiff;
  });
}
