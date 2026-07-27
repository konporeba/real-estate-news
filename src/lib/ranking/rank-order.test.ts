import { describe, expect, it } from "vitest";

import { orderClusters, type ScoredCluster } from "@/lib/ranking/rank-order";

describe("orderClusters", () => {
  it("ranks by score descending when scores are clearly apart", () => {
    const clusters: ScoredCluster[] = [
      { id: "low", score: 40, coverageCount: 1 },
      { id: "high", score: 90, coverageCount: 1 },
      { id: "mid", score: 65, coverageCount: 1 },
    ];

    expect(orderClusters(clusters).map((c) => c.id)).toEqual(["high", "mid", "low"]);
  });

  it("breaks a near-tie by coverage count", () => {
    const clusters: ScoredCluster[] = [
      { id: "a", score: 80, coverageCount: 1 },
      { id: "b", score: 81, coverageCount: 3 },
    ];

    // Scores are within TIE_BAND of each other, so the higher-coverage cluster wins the tie.
    expect(orderClusters(clusters).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("does not let coverage override a clear score gap", () => {
    const clusters: ScoredCluster[] = [
      { id: "weak-but-covered", score: 55, coverageCount: 10 },
      { id: "strong-single-source", score: 90, coverageCount: 1 },
    ];

    expect(orderClusters(clusters).map((c) => c.id)).toEqual(["strong-single-source", "weak-but-covered"]);
  });

  it("does not mutate the input array", () => {
    const clusters: ScoredCluster[] = [
      { id: "a", score: 10, coverageCount: 1 },
      { id: "b", score: 90, coverageCount: 1 },
    ];
    const original = [...clusters];

    orderClusters(clusters);

    expect(clusters).toEqual(original);
  });

  it("passes through extra fields on each cluster", () => {
    const clusters = [{ id: "a", score: 50, coverageCount: 1, note: "keep me" }];

    expect(orderClusters(clusters)[0].note).toBe("keep me");
  });
});
