// The ladder is a table, so the tests are generated from the table: every tier is checked on both
// sides of its ceiling, which means a future recalibration in Phase 7 cannot move a boundary
// without the boundary tests moving with it. What the tests pin is the SHAPE — monotonic, total up
// to the last ceiling, loud past it — not the specific numbers, which are meant to be tuned.
import { describe, expect, it } from "vitest";

import { fitTitle, TITLE_MAX_CHARS, TITLE_SIZE_TIERS, titleLength } from "@/lib/visuals/fit";

/** A title of exactly `length` characters, with no whitespace to collapse. */
const titleOf = (length: number) => "a".repeat(length);

describe("TITLE_SIZE_TIERS", () => {
  it("is ordered by ascending length and descending size", () => {
    for (let index = 1; index < TITLE_SIZE_TIERS.length; index++) {
      const previous = TITLE_SIZE_TIERS[index - 1];
      const current = TITLE_SIZE_TIERS[index];
      expect(current.maxChars).toBeGreaterThan(previous.maxChars);
      expect(current.pointSize).toBeLessThan(previous.pointSize);
    }
  });

  it("exposes the last ceiling as TITLE_MAX_CHARS", () => {
    expect(TITLE_MAX_CHARS).toBe(TITLE_SIZE_TIERS.at(-1)?.maxChars);
  });
});

describe("fitTitle — tier boundaries", () => {
  TITLE_SIZE_TIERS.forEach((tier, index) => {
    it(`sets a ${String(tier.maxChars)}-character title at ${String(tier.pointSize)} pt`, () => {
      const result = fitTitle(titleOf(tier.maxChars));
      expect(result).toEqual({ ok: true, data: tier.pointSize });
    });

    const next = TITLE_SIZE_TIERS.at(index + 1);
    if (next) {
      it(`steps down to ${String(next.pointSize)} pt one character past ${String(tier.maxChars)}`, () => {
        const result = fitTitle(titleOf(tier.maxChars + 1));
        expect(result).toEqual({ ok: true, data: next.pointSize });
      });
    } else {
      it(`fails one character past the last tier (${String(tier.maxChars)})`, () => {
        const result = fitTitle(titleOf(tier.maxChars + 1));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("title_too_long");
        // The measured length is the actionable part of the diagnostic.
        expect(result.message).toContain(String(tier.maxChars + 1));
      });
    }
  });

  it("sets the shortest possible title at the largest size", () => {
    expect(fitTitle("a")).toEqual({ ok: true, data: TITLE_SIZE_TIERS[0].pointSize });
  });
});

describe("fitTitle — degenerate input", () => {
  it("rejects an empty title", () => {
    const result = fitTitle("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_title");
  });

  it("rejects a whitespace-only title", () => {
    const result = fitTitle("   \n\t ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_title");
  });

  it("truncates the offending title in the diagnostic rather than echoing all of it", () => {
    const result = fitTitle(titleOf(TITLE_MAX_CHARS + 200));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeLessThan(200);
  });
});

describe("titleLength", () => {
  it("ignores surrounding whitespace", () => {
    expect(titleLength("  Ceny mieszkań  ")).toBe("Ceny mieszkań".length);
  });

  it("collapses internal whitespace runs, so re-wrapped text does not cost a tier", () => {
    expect(titleLength("Ceny \n  mieszkań")).toBe("Ceny mieszkań".length);
  });

  it("counts a Polish diacritic as one character", () => {
    expect(titleLength("żółć")).toBe(4);
  });

  it("counts an astral character once, not twice", () => {
    expect(titleLength("📈")).toBe(1);
  });

  it("keeps a title that only overflows on whitespace inside its tier", () => {
    const padded = `${titleOf(TITLE_MAX_CHARS)}    `;
    expect(fitTitle(padded).ok).toBe(true);
  });
});
