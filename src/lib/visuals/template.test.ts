import { describe, expect, it } from "vitest";

import type { PageElement, Presentation } from "@/lib/visuals/slides-client";
import {
  CAROUSEL_PAGE_EMU,
  CAROUSEL_SECTIONS,
  type DeckKind,
  elementText,
  isDeckValid,
  parseSlideTag,
  placeholdersIn,
  readCarouselDeck,
  speakerNotes,
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

function deck(kind: "single_post", overrides: Partial<Presentation> = {}): Presentation {
  return {
    presentationId: `deck-${kind}`,
    pageSize: {
      width: { magnitude: TARGET_PAGE_EMU, unit: "EMU" },
      height: { magnitude: TARGET_PAGE_EMU, unit: "EMU" },
    },
    slides: [slideFor(STORY_PLACEHOLDERS, "p1")],
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
    const presentation = deck("single_post");
    presentation.slides = [];

    expect(messages(presentation).some((m) => m.includes("expected 1 slide(s), found 0"))).toBe(true);
  });

  // A deck with the wrong count should still say what is wrong with the slides it has, rather than
  // stopping at a blunt count error.
  it("still checks the slides that exist when the count is wrong", () => {
    const presentation = deck("single_post");
    presentation.slides = [slideFor([], "p1"), slideFor(STORY_PLACEHOLDERS, "p2")];

    const problems = messages(presentation);
    expect(problems.some((m) => m.includes("expected 1 slide(s)"))).toBe(true);
    expect(problems.some((m) => m.includes("missing {{TITLE}}"))).toBe(true);
  });

  it("reports the previous carousel's cover placeholders as unrecognised", () => {
    const presentation = deck("single_post");
    presentation.slides[0].pageElements?.push(box(token("COVER_TITLE"), "el-stray"));

    expect(messages(presentation).some((m) => m.includes("unrecognised placeholder {{COVER_TITLE}}"))).toBe(true);
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

// --- The tag-based carousel deck ---------------------------------------------------------------

/** A slide whose speaker notes carry `notes`, the way Slides returns them. */
const tagged = (objectId: string, notes: string, elements: PageElement[] = []) => ({
  objectId,
  pageElements: elements,
  slideProperties: {
    notesPage: {
      notesProperties: { speakerNotesObjectId: `${objectId}-notes` },
      pageElements: [box(notes, `${objectId}-notes`)],
    },
  },
});

/** The shared title/description box a conforming story slide carries. */
const storyBox = (objectId: string) => box(`${token("TITLE")}\n${token("DESCRIPTION")}\n`, `${objectId}-box`);

const story = (objectId: string, section: string) =>
  tagged(objectId, `role=story section=${section}`, [box("dprealestate.es", `${objectId}-web`), storyBox(objectId)]);

function carouselDeck(overrides: Partial<Presentation> = {}): Presentation {
  return {
    presentationId: "deck-carousel",
    pageSize: {
      width: { magnitude: CAROUSEL_PAGE_EMU.width, unit: "EMU" },
      height: { magnitude: CAROUSEL_PAGE_EMU.height, unit: "EMU" },
    },
    slides: [
      tagged("cover", "role=cover", [box("TYGODNIOWE PODSUMOWANIE", "cover-heading")]),
      story("b1", "barcelona"),
      story("b2", "barcelona"),
      story("s1", "spain"),
      story("f1", "finance_law"),
    ],
    ...overrides,
  };
}

describe("parseSlideTag", () => {
  it("reads a story tag in any order, case and spacing", () => {
    expect(parseSlideTag("  Section=Spain   ROLE=story\n")).toEqual({
      ok: true,
      data: { role: "story", section: "spain" },
    });
  });

  it("reads a cover tag", () => {
    expect(parseSlideTag("role=cover")).toEqual({ ok: true, data: { role: "cover" } });
  });

  it.each([
    ["", "no `role=` tag"],
    ["section=spain", "no `role=` tag"],
    ["role=photo", 'unknown role "photo"'],
    ["role=story", "no `section=` tag"],
    // A typo would silently drop a whole set of photos from rotation, so it must be loud.
    ["role=story section=barcelna", 'unknown section "barcelna"'],
  ])("rejects %j", (notes, expected) => {
    const result = parseSlideTag(notes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(expected);
  });
});

describe("validateDeck — carousel", () => {
  it("accepts a conforming deck", () => {
    expect(validateDeck("carousel", carouselDeck()).problems).toEqual([]);
  });

  it("finds the cover and every story slide with its section and shared box", () => {
    const read = readCarouselDeck(carouselDeck().slides);

    expect(read.cover?.objectId).toBe("cover");
    expect(read.stories.map((s) => [s.slide.objectId, s.section, s.boxElementId])).toEqual([
      ["b1", "barcelona", "b1-box"],
      ["b2", "barcelona", "b2-box"],
      ["s1", "spain", "s1-box"],
      ["f1", "finance_law", "f1-box"],
    ]);
  });

  it("does not care about slide order", () => {
    const slides = carouselDeck().slides.reverse();
    expect(validateDeck("carousel", carouselDeck({ slides })).problems).toEqual([]);
  });

  it("fails a square page and names the 4:5 setup", () => {
    const square = {
      width: { magnitude: TARGET_PAGE_EMU, unit: "EMU" },
      height: { magnitude: TARGET_PAGE_EMU, unit: "EMU" },
    };
    const report = validateDeck("carousel", carouselDeck({ pageSize: square }));

    expect(report.problems.some((p) => p.fatal && p.message.includes("1080 x 1350"))).toBe(true);
  });

  it("warns but does not fail on a 4:5 page of another size", () => {
    const pageSize = { width: { magnitude: 800 * 9525, unit: "EMU" }, height: { magnitude: 1000 * 9525, unit: "EMU" } };
    const report = validateDeck("carousel", carouselDeck({ pageSize }));

    expect(report.problems.some((p) => !p.fatal && p.message.includes("not 1080 px wide"))).toBe(true);
    expect(isDeckValid(report)).toBe(true);
  });

  it("fails an untagged slide", () => {
    const deckWithStray = carouselDeck();
    deckWithStray.slides.push({ objectId: "stray", pageElements: [] });

    expect(messages(deckWithStray, "carousel")).toContain("slide 6 has no `role=` tag in its speaker notes");
  });

  it.each([
    [0, "found 0"],
    [2, "found 2"],
  ])("fails %i covers", (count, expected) => {
    const base = carouselDeck();
    const stories = base.slides.slice(1);
    const covers = Array.from({ length: count }, (_, i) => tagged(`cover${String(i)}`, "role=cover"));

    const problems = messages({ ...base, slides: [...covers, ...stories] }, "carousel");
    expect(problems.some((m) => m.includes("exactly one slide tagged role=cover") && m.includes(expected))).toBe(true);
  });

  it("fails placeholders on the cover", () => {
    const base = carouselDeck();
    base.slides[0] = tagged("cover", "role=cover", [box(token("COVER_TITLE"))]);

    expect(messages(base, "carousel").some((m) => m.includes("the cover is exported as designed"))).toBe(true);
  });

  it.each(CAROUSEL_SECTIONS)("fails a deck with no %s story slide", (section) => {
    const base = carouselDeck();
    const slides = base.slides.filter((slide) => !speakerNotes(slide).includes(`section=${section}`));

    expect(messages({ ...base, slides }, "carousel")).toContain(`no usable story slide tagged section=${section}`);
  });

  // The layout bug this rule prevents: Slides drops "resize to fit" when the API replaces text,
  // so a wrapped headline in its own box runs over a description sitting underneath it.
  it("fails a title and description in separate boxes, once per slide", () => {
    const base = carouselDeck();
    base.slides[1] = tagged("b1", "role=story section=barcelona", [box(token("TITLE")), box(token("DESCRIPTION"))]);

    const shared = messages(base, "carousel").filter((m) => m.includes("must share one text box"));
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatch(/^slide 2:/);
  });

  it("fails the description placed before the title", () => {
    const base = carouselDeck();
    base.slides[1] = tagged("b1", "role=story section=barcelona", [box(`${token("DESCRIPTION")}\n${token("TITLE")}`)]);

    expect(messages(base, "carousel").some((m) => m.includes("title first"))).toBe(true);
  });

  it("fails other text sharing the box", () => {
    const base = carouselDeck();
    base.slides[1] = tagged("b1", "role=story section=barcelona", [
      box(`Nowość: ${token("TITLE")}\n${token("DESCRIPTION")}`),
    ]);

    expect(messages(base, "carousel").some((m) => m.includes("nothing else in it"))).toBe(true);
  });

  it("fails a missing description and an unknown token", () => {
    const base = carouselDeck();
    base.slides[1] = tagged("b1", "role=story section=barcelona", [box(token("TITLE")), box(token("STAT_1_VALUE"))]);

    const problems = messages(base, "carousel");
    expect(problems).toContain("slide 2: missing {{DESCRIPTION}}");
    expect(problems.some((m) => m.includes("unrecognised placeholder {{STAT_1_VALUE}}"))).toBe(true);
  });

  // The renderer sizes each paragraph by range after replacement, starting from these offsets.
  it("records where each token starts in the shared box", () => {
    const story = readCarouselDeck(carouselDeck().slides).stories[0];
    expect([story.titleOffset, story.descriptionOffset]).toEqual([0, "{{TITLE}}\n".length]);
  });

  it("leaves a broken story slide out of the usable set", () => {
    const base = carouselDeck();
    base.slides[1] = tagged("b1", "role=story section=barcelona", [box(token("TITLE"))]);

    expect(readCarouselDeck(base.slides).stories.map((s) => s.slide.objectId)).toEqual(["b2", "s1", "f1"]);
  });
});
