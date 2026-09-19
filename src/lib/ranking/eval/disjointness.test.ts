import { describe, expect, it } from "vitest";

import { findEvalOverlap } from "@/lib/ranking/eval/disjointness";
import { EVAL_EXAMPLES } from "@/lib/ranking/eval/examples";
import type { FewShotExample } from "@/lib/ranking/few-shot";

function fewShot(title: string): FewShotExample {
  return { title, lede: null, tier: "national", picked: true, rationale: "" };
}

describe("findEvalOverlap", () => {
  it("detects an exact title match against the held-out eval set", () => {
    const overlap = findEvalOverlap([fewShot(EVAL_EXAMPLES[0].title)]);

    expect(overlap).toEqual([EVAL_EXAMPLES[0].title.trim().toLowerCase()]);
  });

  it("still counts a case/whitespace-only difference as overlap", () => {
    const noisyTitle = `  ${EVAL_EXAMPLES[0].title.toUpperCase()}  `;

    const overlap = findEvalOverlap([fewShot(noisyTitle)]);

    expect(overlap).toEqual([EVAL_EXAMPLES[0].title.trim().toLowerCase()]);
  });

  it("returns an empty array for a clean disjoint set", () => {
    const overlap = findEvalOverlap([fewShot("Un titular que no aparece en el set de evaluación")]);

    expect(overlap).toEqual([]);
  });
});
