import { describe, expect, it } from "vitest";

import type { PageElement, Presentation } from "@/lib/visuals/slides-client";
import {
  COVER_PLACEHOLDERS,
  type DeckKind,
  elementText,
  isDeckValid,
  placeholdersIn,
  STORY_PLACEHOLDERS,
  TARGET_PAGE_EMU,
  token,
  validateDeck,
} from "@/lib/visuals/template";

/** One text box holding the given text. Element ids are irrelevant to validation; names are not. */
const box = (text: string, objectId = `el-${text}`): PageElement => ({
  objectId,
  shape: { text: { textElements: [{ textRun: { content: text } }] } },
});

/** A slide with one text box per placeholder — the shape the spec requires. */
const slideFor = (names: readonly string[], objectId: string) => ({
  objectId,
  pageElements: names.map((name) => box(token(name), `el-${name}`)),
});

function deck(kind: DeckKind, overrides: Partial<Presentation> = {}): Presentation {
  const slides =
    kind === "single_post"
      ? [slideFor(STORY_PLACEHOLDERS, "p1")]
      : [slideFor(COVER_PLACEHOLDERS, "p1"), slideFor(STORY_PLACEHOLDERS, "p2")];

  return {
    presentationId: "deck-1",
    pageSize: {
      width: { magnitude: TARGET_PAGE_EMU, unit: "EMU" },
      height: { magnitude: TARGET_PAGE_EMU, unit: "EMU" },
    },
    slides,
    ...overrides,
  };
}

const messages = (presentation: Presentation, kind: DeckKind = "single_post") =>
  validateDeck(kind, presentation).problems.map((problem) => problem.message);

describe("placeholdersIn", () => {
  it("finds every token, including repeats, in order", () => {
    expect(placeholdersIn("{{TITLE}} then {{STAT_1_VALUE}} then {{TITLE}}")).toEqual([
      "TITLE",
      "STAT_1_VALUE",
      "TITLE",
    ]);
  });

  it("finds nothing in ordinary prose", () => {
    expect(placeholdersIn("Ceny mieszkań w Barcelonie")).toEqual([]);
  });

  // Slides splits a text run at every style change, so a bolded word mid-token would break a
  // naive per-run scan. elementText joins first for exactly this reason.
  it("survives a token split across styled runs once joined", () => {
    const element: PageElement = {
      objectId: "el",
      shape: { text: { textElements: [{ textRun: { content: "{{TIT" } }, { textRun: { content: "LE}}" } }] } },
    };
    expect(placeholdersIn(elementText(element))).toEqual(["TITLE"]);
  });
});

describe("validateDeck — conforming decks", () => {
  it("accepts a correct single-post deck", () => {
    expect(validateDeck("single_post", deck("single_post")).problems).toEqual([]);
  });

  it("accepts a correct carousel deck", () => {
    expect(validateDeck("carousel", deck("carousel")).problems).toEqual([]);
  });

  it("ignores decorative elements with no placeholders", () => {
    const presentation = deck("single_post");
    presentation.slides[0].pageElements?.push(box("Real Estate News"), { objectId: "logo" });
    expect(validateDeck("single_post", presentation).problems).toEqual([]);
  });
});

describe("validateDeck — seeded defects", () => {
  it("reports a missing placeholder", () => {
    const presentation = deck("single_post");
    presentation.slides[0].pageElements = presentation.slides[0].pageElements?.filter(
      (element) => element.objectId !== "el-STAT_2_VALUE",
    );

    const problems = messages(presentation);
    expect(problems.some((m) => m.includes("missing {{STAT_2_VALUE}}"))).toBe(true);
    expect(isDeckValid(validateDeck("single_post", presentation))).toBe(false);
  });

  // The failure this whole command exists to prevent: a typo reads as designed text in the deck
  // and only shows up as {{TITTLE}} printed across a finished card.
  it("reports a misspelled placeholder as both missing and unrecognised", () => {
    const presentation = deck("single_post");
    presentation.slides[0].pageElements = presentation.slides[0].pageElements?.map((element) =>
      element.objectId === "el-TITLE" ? box("{{TITTLE}}", "el-TITLE") : element,
    );

    const problems = messages(presentation);
    expect(problems.some((m) => m.includes("missing {{TITLE}}"))).toBe(true);
    expect(problems.some((m) => m.includes("unrecognised placeholder {{TITTLE}}"))).toBe(true);
  });

  it("reports a duplicated placeholder", () => {
    const presentation = deck("single_post");
    presentation.slides[0].pageElements?.push(box(token("TITLE"), "el-TITLE-again"));

    expect(messages(presentation).some((m) => m.includes("{{TITLE}} appears 2 times"))).toBe(true);
  });

  // Not a replaceAllText problem — a fit problem. The title element is resized wholesale, so
  // anything sharing its box gets resized with it, silently.
  it("reports several placeholders sharing one text box", () => {
    const presentation = deck("single_post");
    presentation.slides[0].pageElements = [
      box(`${token("TITLE")} ${token("STAT_1_LABEL")}`, "el-shared"),
      ...STORY_PLACEHOLDERS.filter((name) => name !== "TITLE" && name !== "STAT_1_LABEL").map((name) =>
        box(token(name), `el-${name}`),
      ),
    ];

    expect(messages(presentation).some((m) => m.includes("one text box holds several placeholders"))).toBe(true);
  });

  it("reports the wrong slide count", () => {
    const presentation = deck("carousel");
    presentation.slides = [presentation.slides[0]];

    expect(messages(presentation, "carousel").some((m) => m.includes("expected 2 slide(s), found 1"))).toBe(true);
  });

  // A deck with too few slides should still say what is wrong with the slides it has, rather than
  // stopping at a blunt count error.
  it("still checks the slides that exist when the count is wrong", () => {
    const presentation = deck("carousel");
    presentation.slides = [slideFor([], "p1")];

    const problems = messages(presentation, "carousel");
    expect(problems.some((m) => m.includes("expected 2 slide(s)"))).toBe(true);
    expect(problems.some((m) => m.includes("missing {{COVER_TITLE}}"))).toBe(true);
  });

  it("reports cover placeholders used on a story slide", () => {
    const presentation = deck("carousel");
    presentation.slides[1].pageElements?.push(box(token("COVER_TITLE"), "el-stray"));

    expect(messages(presentation, "carousel").some((m) => m.includes("unrecognised placeholder {{COVER_TITLE}}"))).toBe(
      true,
    );
  });
});

describe("validateDeck — page size", () => {
  // Slides' default is 16:9. Letting that through would produce letterboxed posts on every
  // platform, which is why it is fatal rather than a warning.
  it("fails a non-square page", () => {
    const presentation = deck("single_post", {
      pageSize: {
        width: { magnitude: 9144000, unit: "EMU" },
        height: { magnitude: 5143500, unit: "EMU" },
      },
    });

    const report = validateDeck("single_post", presentation);
    expect(report.problems.some((p) => p.fatal && p.message.includes("not square"))).toBe(true);
    expect(isDeckValid(report)).toBe(false);
  });

  // Square but a different density still renders correctly, so it must not block a run.
  it("warns but does not fail on a square page of the wrong size", () => {
    const square = 800 * 9525;
    const presentation = deck("single_post", {
      pageSize: { width: { magnitude: square, unit: "EMU" }, height: { magnitude: square, unit: "EMU" } },
    });

    const report = validateDeck("single_post", presentation);
    expect(report.problems.some((p) => !p.fatal && p.message.includes("not 1080 px"))).toBe(true);
    expect(isDeckValid(report)).toBe(true);
  });

  it("warns rather than failing when the page size is unreadable", () => {
    const report = validateDeck("single_post", deck("single_post", { pageSize: {} }));

    expect(report.problems.some((p) => !p.fatal && p.message.includes("page size"))).toBe(true);
    expect(isDeckValid(report)).toBe(true);
  });
});
