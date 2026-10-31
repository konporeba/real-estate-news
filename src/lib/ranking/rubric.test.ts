// Unit tests for buildRubricSystemPrompt (S-09/FR-025) — a pure function, no DB/LLM needed.
import { describe, expect, it } from "vitest";

import type { FewShotExample } from "@/lib/ranking/few-shot";
import { EVAL_EXAMPLES } from "@/lib/ranking/eval/examples";
import { buildRubricSystemPrompt, GEOGRAPHY_RUBRIC_SYSTEM } from "@/lib/ranking/rubric";

describe("buildRubricSystemPrompt", () => {
  it("returns the bare rubric unchanged when given no few-shot examples", () => {
    expect(buildRubricSystemPrompt([])).toBe(GEOGRAPHY_RUBRIC_SYSTEM);
  });

  it("appends a well-formed section for a non-empty few-shot list", () => {
    const examples: FewShotExample[] = [
      {
        title: "El Gobierno aprueba una nueva ley de vivienda",
        lede: "La norma afecta a todo el territorio nacional.",
        tier: "national",
        picked: true,
        rationale: "National housing regulation.",
      },
      {
        title: "Cierra un chiringuito en el Maresme",
        lede: null,
        tier: "discard",
        picked: false,
        rationale: "Off-topic, not real estate.",
      },
    ];

    const prompt = buildRubricSystemPrompt(examples);

    expect(prompt.startsWith(GEOGRAPHY_RUBRIC_SYSTEM)).toBe(true);
    expect(prompt).toContain("PAST EDITORIAL DECISIONS");
    expect(prompt).toContain("El Gobierno aprueba una nueva ley de vivienda");
    expect(prompt).toContain("La norma afecta a todo el territorio nacional.");
    expect(prompt).toContain("PICKED (national): National housing regulation.");
    expect(prompt).toContain("Cierra un chiringuito en el Maresme");
    expect(prompt).toContain("PASSED (discard): Off-topic, not real estate.");
  });

  it("omits a second line for an example with no lede", () => {
    const examples: FewShotExample[] = [
      { title: "Solo title", lede: null, tier: "catalonia", picked: true, rationale: "r" },
    ];

    const prompt = buildRubricSystemPrompt(examples);

    expect(prompt).toContain("- Solo title\n  → PICKED (catalonia): r");
  });
});

describe("GEOGRAPHY_RUBRIC_SYSTEM", () => {
  it("asks for the finance/law flag the carousel sections depend on", () => {
    expect(GEOGRAPHY_RUBRIC_SYSTEM).toContain('"financeLaw"');
  });

  // The eval only measures generalization while its stories stay out of the prompt — easy to
  // break by quoting a "typical" example while tuning the wording.
  it("contains none of the held-out eval stories", () => {
    for (const example of EVAL_EXAMPLES) expect(GEOGRAPHY_RUBRIC_SYSTEM).not.toContain(example.title);
  });
});
