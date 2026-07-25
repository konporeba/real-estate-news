// WORKER-SIDE. The eval gate's assertion logic: given a scorer and a labeled set, check that every
// example lands in its correct geography tier and that every expected ordering pair holds.
//
// It asserts TIER and ORDERING, never exact scores (US-25 over a non-deterministic scorer). A tier
// flip or a pairwise inversion is a real regression; a few points of numeric jitter is not. This
// module is pure over an injected `scorer`, so its logic is unit-testable on synthetic scored data
// with no API call; Phase 2 wires the real rubric scorer in.
import type { ClusterScore, GeographyTier } from "@/lib/ranking/score";

/** A held-out labeled example. `id` is referenced by ordering pairs. */
export interface LabeledExample {
  id: string;
  title: string;
  lede: string | null;
  /** The tier the operator judged correct — what the gate asserts. */
  expectedTier: GeographyTier;
  /** Why, for the human reviewing the set (not sent to the model). */
  note: string;
}

/** `[higherId, lowerId]` — the first example must rank strictly above the second. */
export type OrderingPair = [string, string];

/** Scores one example. The real implementation (Phase 2) routes through F-03's invoke(). */
export type Scorer = (example: LabeledExample) => Promise<ClusterScore>;

export interface TierFailure {
  id: string;
  expected: GeographyTier;
  actual: GeographyTier;
}

export interface OrderingFailure {
  higher: string;
  lower: string;
  higherScore: number;
  lowerScore: number;
}

export interface EvalReport {
  passed: boolean;
  tierFailures: TierFailure[];
  orderingFailures: OrderingFailure[];
  /** Every example's score, keyed by id — for a readable drift report. */
  scores: Record<string, ClusterScore>;
}

/**
 * Score every example once, then check tiers and orderings.
 *
 * Each example is scored a single time and the result reused for both the tier check and any
 * ordering pairs it participates in — so the gate is one scoring pass over the set, and an ordering
 * pair compares the same two scores the tier check saw. `passed` is true iff there are no failures
 * of either kind. An ordering pair referencing an unknown id is itself a failure (a malformed set
 * must not silently pass).
 */
export async function evaluateRubric(
  scorer: Scorer,
  examples: LabeledExample[],
  orderings: OrderingPair[],
): Promise<EvalReport> {
  // A Map (not a Record) so an ordering pair referencing an id NOT in the labeled set is an honest
  // `undefined` on lookup, not a type lie — that case is a broken eval and must fail, not pass.
  const scored = new Map<string, ClusterScore>();
  for (const example of examples) {
    scored.set(example.id, await scorer(example));
  }

  const tierFailures: TierFailure[] = [];
  for (const example of examples) {
    const s = scored.get(example.id);
    if (s && s.tier !== example.expectedTier) {
      tierFailures.push({ id: example.id, expected: example.expectedTier, actual: s.tier });
    }
  }

  const orderingFailures: OrderingFailure[] = [];
  for (const [higher, lower] of orderings) {
    const hi = scored.get(higher);
    const lo = scored.get(lower);
    if (!hi || !lo) {
      // A pair naming an id not in the set is a broken eval, not a pass.
      orderingFailures.push({
        higher,
        lower,
        higherScore: hi?.score ?? Number.NaN,
        lowerScore: lo?.score ?? Number.NaN,
      });
      continue;
    }
    if (!(hi.score > lo.score)) {
      orderingFailures.push({ higher, lower, higherScore: hi.score, lowerScore: lo.score });
    }
  }

  return {
    passed: tierFailures.length === 0 && orderingFailures.length === 0,
    tierFailures,
    orderingFailures,
    scores: Object.fromEntries(scored),
  };
}

/** A human-readable one-block summary of a report — printed by the eval suite on failure. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [`eval ${report.passed ? "PASSED" : "FAILED"}`];
  for (const f of report.tierFailures) {
    lines.push(`  tier: ${f.id} expected ${f.expected}, got ${f.actual}`);
  }
  for (const f of report.orderingFailures) {
    lines.push(`  order: ${f.higher} (${f.higherScore}) should outrank ${f.lower} (${f.lowerScore})`);
  }
  return lines.join("\n");
}
