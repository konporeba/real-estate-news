import { describe, expect, it } from "vitest";

import { assignSections, assignSlides, isoWeekNumber, storySections } from "@/lib/visuals/sections";
import type { CarouselSection, CarouselStorySlide } from "@/lib/visuals/template";

describe("storySections", () => {
  it.each([
    [{ tier: "catalonia", financeLaw: false }, ["barcelona"]],
    [{ tier: "national", financeLaw: false }, ["spain"]],
    [{ tier: "global", financeLaw: false }, ["spain"]],
    // A Barcelona rent law: geography first, finance/law as the alternative.
    [{ tier: "catalonia", financeLaw: true }, ["barcelona", "finance_law"]],
    [{ tier: "national", financeLaw: true }, ["spain", "finance_law"]],
    // The operator may pick a story ranking discarded; it still needs a slide.
    [{ tier: "discard", financeLaw: true }, ["finance_law"]],
    [{ tier: "discard", financeLaw: false }, ["spain"]],
    // A cluster ranked before the flag existed has no financeLaw at all.
    [{ tier: "catalonia" }, ["barcelona"]],
  ])("%j → %j", (detail, expected) => {
    expect(storySections(detail)).toEqual(expected);
  });

  it("falls back to spain when there is no ranking detail", () => {
    expect(storySections(null)).toEqual(["spain"]);
  });
});

describe("assignSections", () => {
  const bcnLaw = { tier: "catalonia", financeLaw: true };
  const spainLaw = { tier: "national", financeLaw: true };

  it("gives a single-section story its only section, however crowded", () => {
    const plain = { tier: "catalonia", financeLaw: false };
    expect(assignSections([plain, plain, plain])).toEqual(["barcelona", "barcelona", "barcelona"]);
  });

  // The tie rule: nothing used yet, so the lead story takes its geography.
  it("breaks a tie towards geography", () => {
    expect(assignSections([bcnLaw])).toEqual(["barcelona"]);
  });

  // The variety rule that drives the whole feature.
  it("sends a two-section story to the section used least so far", () => {
    expect(assignSections([bcnLaw, bcnLaw, bcnLaw, bcnLaw])).toEqual([
      "barcelona",
      "finance_law",
      "barcelona",
      "finance_law",
    ]);
  });

  it("counts every earlier story, not only two-section ones", () => {
    const plainSpain = { tier: "national", financeLaw: false };
    // Spain is already used once, finance/law not at all, so the flagged Spain story moves over.
    expect(assignSections([plainSpain, spainLaw])).toEqual(["spain", "finance_law"]);
  });

  it("follows the order given, which is shortlist order", () => {
    const plainLaw = { tier: "discard", financeLaw: true };
    expect(assignSections([plainLaw, bcnLaw])).toEqual(["finance_law", "barcelona"]);
    expect(assignSections([bcnLaw, plainLaw])).toEqual(["barcelona", "finance_law"]);
  });
});

describe("isoWeekNumber", () => {
  it.each([
    ["2026-10-26", 44],
    ["2026-01-01", 1], // a Thursday: week 1 of 2026
    ["2027-01-01", 53], // a Friday: still the last ISO week of 2026
    ["2026-12-28", 53],
    ["2025-12-29", 1], // a Monday that belongs to ISO 2026
  ])("%s is week %i", (date, week) => {
    expect(isoWeekNumber(date)).toBe(week);
  });
});

describe("assignSlides", () => {
  const slide = (id: string, section: CarouselSection): CarouselStorySlide => ({
    slide: { objectId: id },
    section,
    boxElementId: `${id}-box`,
    titleOffset: 0,
    descriptionOffset: 10,
  });
  const deck = [
    slide("b1", "barcelona"),
    slide("s1", "spain"),
    slide("b2", "barcelona"),
    slide("b3", "barcelona"),
    slide("f1", "finance_law"),
  ];
  const ids = (picked: (CarouselStorySlide | null)[]) => picked.map((p) => p?.slide.objectId ?? null);

  it("starts each section at the week's offset, in deck order", () => {
    expect(ids(assignSlides(["barcelona"], deck, 0))).toEqual(["b1"]);
    expect(ids(assignSlides(["barcelona"], deck, 1))).toEqual(["b2"]);
    expect(ids(assignSlides(["barcelona"], deck, 5))).toEqual(["b3"]);
  });

  it("never repeats a photo in one carousel while the section has more", () => {
    expect(ids(assignSlides(["barcelona", "spain", "barcelona", "barcelona"], deck, 2))).toEqual([
      "b3",
      "s1",
      "b1",
      "b2",
    ]);
  });

  it("cycles when a section has fewer photos than stories", () => {
    expect(ids(assignSlides(["spain", "spain"], deck, 7))).toEqual(["s1", "s1"]);
  });

  it("gives null for a section the deck has no slide for", () => {
    expect(ids(assignSlides(["finance_law"], deck.slice(0, 4), 0))).toEqual([null]);
  });
});
