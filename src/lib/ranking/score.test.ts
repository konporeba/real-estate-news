import { describe, expect, it } from "vitest";

import {
  assertScoreInRange,
  clusterScoreSchema,
  GEOGRAPHY_TIERS,
  isScoreInRange,
  TIER_BANDS,
} from "@/lib/ranking/score";

describe("clusterScoreSchema", () => {
  const valid = { tier: "catalonia" as const, topics: ["rental-prices"], score: 88, rationale: "Barcelona rents" };

  it("round-trips a valid score", () => {
    const parsed = clusterScoreSchema.parse(valid);
    expect(parsed.tier).toBe("catalonia");
    expect(parsed.topics).toEqual(["rental-prices"]);
    expect(parsed.score).toBe(88);
  });

  it("rejects an unknown tier", () => {
    expect(clusterScoreSchema.safeParse({ ...valid, tier: "madrid" }).success).toBe(false);
  });

  it("accepts an empty topics list (a discard may have no topic)", () => {
    expect(clusterScoreSchema.safeParse({ ...valid, tier: "discard", topics: [], score: 5 }).success).toBe(true);
  });

  it("rejects a non-numeric score", () => {
    expect(clusterScoreSchema.safeParse({ ...valid, score: "high" }).success).toBe(false);
  });

  // The schema deliberately does NOT range-check the number (F-03 forbids numeric constraints in
  // the schema sent to the API); range is enforced separately.
  it("parses an out-of-range number at the schema level (range is a separate check)", () => {
    expect(clusterScoreSchema.safeParse({ ...valid, score: 250 }).success).toBe(true);
  });
});

describe("score range", () => {
  it("accepts 0–100 inclusive", () => {
    expect(isScoreInRange(0)).toBe(true);
    expect(isScoreInRange(100)).toBe(true);
    expect(isScoreInRange(50)).toBe(true);
  });

  it("rejects out-of-range and non-finite values", () => {
    expect(isScoreInRange(-1)).toBe(false);
    expect(isScoreInRange(101)).toBe(false);
    expect(isScoreInRange(Number.NaN)).toBe(false);
    expect(isScoreInRange(Infinity)).toBe(false);
  });

  it("assertScoreInRange throws on a bad value and is silent on a good one", () => {
    expect(() => {
      assertScoreInRange(88);
    }).not.toThrow();
    expect(() => {
      assertScoreInRange(250);
    }).toThrow(/0–100/);
  });
});

describe("TIER_BANDS", () => {
  it("has a band for every tier", () => {
    for (const tier of GEOGRAPHY_TIERS) {
      expect(TIER_BANDS[tier]).toBeDefined();
    }
  });

  it("bands are ordered and non-overlapping, so tier implies a score range", () => {
    // catalonia > national > global > discard, contiguous and disjoint.
    expect(TIER_BANDS.discard.max).toBeLessThan(TIER_BANDS.global.min);
    expect(TIER_BANDS.global.max).toBeLessThan(TIER_BANDS.national.min);
    expect(TIER_BANDS.national.max).toBeLessThan(TIER_BANDS.catalonia.min);
  });
});
