// The ladder is a table, so the tests are generated from the table: every tier is checked on both
// sides of its ceiling, which means a future recalibration in Phase 7 cannot move a boundary
// without the boundary tests moving with it. What the tests pin is the SHAPE — monotonic, total up
// to the last ceiling, loud past it — not the specific numbers, which are meant to be tuned.
import { describe, expect, it } from "vitest";

import {
  CAROUSEL_BOX_PT,
  CAROUSEL_SIZE_TIERS,
  estimatedCarouselHeight,
  fitCarouselText,
  fitTitle,
  TITLE_MAX_CHARS,
  TITLE_SIZE_TIERS,
  titleLength,
} from "@/lib/digest/fit";

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

describe("carousel text fit", () => {
  // Real copy shape from the calibration render (2026-10-31): 98 + 107 characters, which wrapped
  // to 4 + 3 lines at 32/22 pt and filled 277 pt of the 367 pt box.
  const calibrationTitle =
    "Euribor spada do 2,1% – raty kredytów hipotecznych w Hiszpanii będą niższe nawet o 60 € miesięcznie";
  const calibrationDescription =
    "Dla kredytu 200 000 € na 25 lat oznacza to oszczędność około 720 € rocznie przy następnej aktualizacji oprocentowania.";

  it("reproduces the calibration render's height within a line", () => {
    const height = estimatedCarouselHeight(calibrationTitle, calibrationDescription, CAROUSEL_SIZE_TIERS[0]);
    expect(Math.abs(height - 277)).toBeLessThan(25);
  });

  it("keeps typical copy at the full sizes", () => {
    expect(fitCarouselText(calibrationTitle, calibrationDescription)).toEqual({
      ok: true,
      data: { titlePt: 32, descriptionPt: 22 },
    });
  });

  it("steps down for longer copy, title first", () => {
    const result = fitCarouselText("a".repeat(110), "b".repeat(300));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).not.toEqual(CAROUSEL_SIZE_TIERS[0]);
    expect(result.data.titlePt).toBeLessThan(32);
  });

  it("returns the first tier that fits, never a smaller one", () => {
    const result = fitCarouselText("a".repeat(120), "b".repeat(260));
    if (!result.ok) throw new Error(result.message);
    const index = CAROUSEL_SIZE_TIERS.findIndex((tier) => tier === result.data);
    expect(index).toBeGreaterThan(-1);
    for (const larger of CAROUSEL_SIZE_TIERS.slice(0, index)) {
      expect(estimatedCarouselHeight("a".repeat(120), "b".repeat(260), larger)).toBeGreaterThan(CAROUSEL_BOX_PT.height);
    }
  });

  it("fails past the smallest tier, naming both lengths", () => {
    const result = fitCarouselText("a".repeat(200), "b".repeat(700));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("text_too_long");
    expect(result.message).toContain("200 characters");
    expect(result.message).toContain("700 characters");
  });

  it.each([
    ["", "Opis", "empty_title"],
    ["Tytuł", "  ", "empty_description"],
  ])("rejects blank text (%j, %j) as %s", (title, description, reason) => {
    const result = fitCarouselText(title, description);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it("orders the tiers from largest to smallest", () => {
    for (let index = 1; index < CAROUSEL_SIZE_TIERS.length; index++) {
      const previous = CAROUSEL_SIZE_TIERS[index - 1];
      const current = CAROUSEL_SIZE_TIERS[index];
      expect(current.titlePt + current.descriptionPt).toBeLessThan(previous.titlePt + previous.descriptionPt);
      expect(current.titlePt).toBeLessThanOrEqual(previous.titlePt);
      expect(current.descriptionPt).toBeLessThanOrEqual(previous.descriptionPt);
    }
  });
});
