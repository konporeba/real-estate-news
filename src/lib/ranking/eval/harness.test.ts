import { describe, expect, it } from "vitest";

import { evaluateRubric, type LabeledExample, type Scorer } from "@/lib/ranking/eval/harness";
import type { ClusterScore, GeographyTier } from "@/lib/ranking/score";

function example(id: string, expectedTier: GeographyTier): LabeledExample {
  return { id, title: id, lede: null, expectedTier, note: "" };
}

/** A deterministic scorer driven by a fixed map — no API, no jitter. */
function scorerFrom(map: Record<string, { tier: GeographyTier; score: number }>): Scorer {
  return (ex) => {
    const s = map[ex.id];
    const result: ClusterScore = { tier: s.tier, topics: [], score: s.score, rationale: "" };
    return Promise.resolve(result);
  };
}

describe("evaluateRubric", () => {
  it("passes when every tier matches and every ordering holds", async () => {
    const examples = [example("bcn", "catalonia"), example("madrid", "discard")];
    const scorer = scorerFrom({ bcn: { tier: "catalonia", score: 90 }, madrid: { tier: "discard", score: 10 } });

    const report = await evaluateRubric(scorer, examples, [["bcn", "madrid"]]);

    expect(report.passed).toBe(true);
    expect(report.tierFailures).toHaveLength(0);
    expect(report.orderingFailures).toHaveLength(0);
  });

  it("reports a tier mismatch", async () => {
    const examples = [example("national-story", "national")];
    // Model wrongly tiered a national story as discard (the published-vs-effects misjudgment).
    const scorer = scorerFrom({ "national-story": { tier: "discard", score: 15 } });

    const report = await evaluateRubric(scorer, examples, []);

    expect(report.passed).toBe(false);
    expect(report.tierFailures).toEqual([{ id: "national-story", expected: "national", actual: "discard" }]);
  });

  it("reports an ordering inversion (US-06: Barcelona rental must outrank Madrid political)", async () => {
    const examples = [example("bcn-rental", "catalonia"), example("madrid-politics", "discard")];
    // Tiers happen to be right, but the numbers invert the required order.
    const scorer = scorerFrom({
      "bcn-rental": { tier: "catalonia", score: 40 },
      "madrid-politics": { tier: "discard", score: 50 },
    });

    const report = await evaluateRubric(scorer, examples, [["bcn-rental", "madrid-politics"]]);

    expect(report.passed).toBe(false);
    expect(report.orderingFailures).toHaveLength(1);
    expect(report.orderingFailures[0]).toMatchObject({ higher: "bcn-rental", lower: "madrid-politics" });
  });

  it("treats equal scores as an ordering failure (must be strictly higher)", async () => {
    const examples = [example("a", "national"), example("b", "national")];
    const scorer = scorerFrom({ a: { tier: "national", score: 60 }, b: { tier: "national", score: 60 } });

    const report = await evaluateRubric(scorer, examples, [["a", "b"]]);

    expect(report.passed).toBe(false);
  });

  it("fails an ordering pair that references an unknown id rather than silently passing", async () => {
    const examples = [example("a", "national")];
    const scorer = scorerFrom({ a: { tier: "national", score: 60 } });

    const report = await evaluateRubric(scorer, examples, [["a", "ghost"]]);

    expect(report.passed).toBe(false);
    expect(report.orderingFailures).toHaveLength(1);
  });

  it("scores each example exactly once and returns them keyed by id", async () => {
    const examples = [example("a", "national"), example("b", "global")];
    let calls = 0;
    const scorer: Scorer = (ex) => {
      calls += 1;
      return Promise.resolve({ tier: ex.expectedTier, topics: [], score: 55, rationale: "" });
    };

    const report = await evaluateRubric(scorer, examples, [["a", "b"]]);

    expect(calls).toBe(2); // one pass over the set, reused for the ordering check
    expect(Object.keys(report.scores).sort()).toEqual(["a", "b"]);
  });
});
