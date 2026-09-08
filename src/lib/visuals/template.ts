// WORKER-SIDE, but pure: no network, no credentials, no clock. This module is the single
// definition of the contract between the operator's design work in Google Slides and the code that
// fills it. `template-spec.md` in the change folder is the human-facing rendering of exactly what
// is declared here — if the two ever disagree, this file is right and the document is stale.
//
// The whole point of FR-015 is that the operator restyles without a deploy. That only holds if the
// code depends on placeholder NAMES and nothing else: not positions, not colours, not fonts, not
// the order of elements on the page. Everything below is name-based for that reason.
import type { PageElement, Presentation, Slide } from "@/lib/visuals/slides-client";

/** Placeholders on a story slide — one per selected story. */
export const STORY_PLACEHOLDERS = [
  "TITLE",
  "STAT_1_LABEL",
  "STAT_1_VALUE",
  "STAT_2_LABEL",
  "STAT_2_VALUE",
  "STAT_3_LABEL",
  "STAT_3_VALUE",
] as const;

/** Placeholders on a carousel's cover slide, which represents the week rather than a story. */
export const COVER_PLACEHOLDERS = ["COVER_TITLE", "COVER_SUBTITLE"] as const;

export type StoryPlaceholder = (typeof STORY_PLACEHOLDERS)[number];
export type CoverPlaceholder = (typeof COVER_PLACEHOLDERS)[number];
export type Placeholder = StoryPlaceholder | CoverPlaceholder;

/** The placeholder that carries the headline, and so the one the fit step resizes. */
export const TITLE_PLACEHOLDER = "TITLE" satisfies StoryPlaceholder;

/** How a placeholder appears in the deck. Braces, no spaces: `{{TITLE}}`. */
export function token(placeholder: string): string {
  return `{{${placeholder}}}`;
}

/** Matches any `{{...}}` token, so unknown ones can be reported rather than silently ignored. */
const TOKEN_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * Templates are designed at 1080x1080 px. Slides stores page size in EMU; at 96 DPI one pixel is
 * 9525 EMU, so 1080 px is 10,287,000 EMU. Entering "1080 px" or "810 pt" in Slides' page setup
 * both land here.
 */
export const TARGET_PAGE_EMU = 1080 * 9525;

/** Page-size tolerance. Generous on purpose: aspect ratio is what platforms care about, not exact EMU. */
const PAGE_SIZE_TOLERANCE = 0.02;

/** Which slides a deck must have, and what belongs on each. */
export interface DeckSpec {
  /** Exact number of slides the deck must contain. */
  slideCount: number;
  /** Required placeholders per slide, indexed by slide position. */
  slides: readonly (readonly string[])[];
}

export const DECK_SPECS = {
  // One slide, rendered once per selected story.
  single_post: {
    slideCount: 1,
    slides: [STORY_PLACEHOLDERS],
  },
  // Slide 0 is the cover; slide 1 is the story template, duplicated once per story at render time.
  carousel: {
    slideCount: 2,
    slides: [COVER_PLACEHOLDERS, STORY_PLACEHOLDERS],
  },
} as const satisfies Record<string, DeckSpec>;

export type DeckKind = keyof typeof DECK_SPECS;

/** All the text on one page element, joined. Slides splits a run at every style change. */
export function elementText(element: PageElement): string {
  const runs = element.shape?.text?.textElements ?? [];
  return runs.map((run) => run.textRun?.content ?? "").join("");
}

/** Every `{{TOKEN}}` name appearing in a string, in order, including repeats. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(TOKEN_PATTERN)].map((match) => match[1]);
}

/** One thing wrong with a deck. `fatal` decides the validator's exit code. */
export interface DeckProblem {
  fatal: boolean;
  message: string;
}

export interface DeckReport {
  kind: DeckKind;
  presentationId: string;
  problems: DeckProblem[];
}

export function isDeckValid(report: DeckReport): boolean {
  return !report.problems.some((problem) => problem.fatal);
}

function checkPageSize(presentation: Presentation): DeckProblem[] {
  const width = presentation.pageSize?.width?.magnitude;
  const height = presentation.pageSize?.height?.magnitude;
  if (typeof width !== "number" || typeof height !== "number") {
    return [{ fatal: false, message: "could not read the deck's page size; skipping the size check" }];
  }

  const problems: DeckProblem[] = [];
  // Non-square is FATAL: the whole per-platform story rests on one square asset serving Instagram,
  // LinkedIn and Facebook alike. A 16:9 deck (Slides' default) would silently produce letterboxed
  // posts on every platform.
  if (Math.abs(width - height) > width * PAGE_SIZE_TOLERANCE) {
    problems.push({
      fatal: true,
      message:
        `page is not square (${Math.round(width)} x ${Math.round(height)} EMU). ` +
        `Set File > Page setup > Custom to 1080 x 1080 px.`,
    });
  }
  // Wrong-but-square is a WARNING: it still renders correctly, just not at the intended density.
  if (Math.abs(width - TARGET_PAGE_EMU) > TARGET_PAGE_EMU * PAGE_SIZE_TOLERANCE) {
    problems.push({
      fatal: false,
      message:
        `page is square but not 1080 px (${Math.round(width / 9525)} px). ` +
        `This still renders; it is only a density difference.`,
    });
  }
  return problems;
}

function checkSlide(slide: Slide, index: number, required: readonly string[]): DeckProblem[] {
  const problems: DeckProblem[] = [];
  const elements = slide.pageElements ?? [];
  const requiredSet = new Set<string>(required);

  // Count every occurrence across the page, and remember which element each came from so a
  // placeholder sharing a text box can be named precisely.
  const occurrences = new Map<string, number>();
  for (const element of elements) {
    const found = placeholdersIn(elementText(element));
    for (const name of found) occurrences.set(name, (occurrences.get(name) ?? 0) + 1);

    // Each placeholder needs its own text box. `replaceAllText` would cope with two in one box,
    // but the fit step resizes the TITLE element wholesale — anything sharing that box would be
    // resized with it, which is a silent layout bug rather than a loud failure.
    if (found.length > 1) {
      problems.push({
        fatal: true,
        message: `slide ${index + 1}: one text box holds several placeholders (${found.map(token).join(" ")}). Give each its own text box.`,
      });
    }
  }

  for (const name of required) {
    const count = occurrences.get(name) ?? 0;
    if (count === 0) {
      problems.push({ fatal: true, message: `slide ${index + 1}: missing ${token(name)}` });
    } else if (count > 1) {
      problems.push({
        fatal: true,
        message: `slide ${index + 1}: ${token(name)} appears ${count} times; it must appear exactly once`,
      });
    }
  }

  for (const name of occurrences.keys()) {
    if (!requiredSet.has(name)) {
      problems.push({
        fatal: true,
        message: `slide ${index + 1}: unrecognised placeholder ${token(name)} — check the spelling against template-spec.md`,
      });
    }
  }

  return problems;
}

/**
 * Check one deck against its spec.
 *
 * Every fatal problem here is one that would otherwise surface as a broken image in the middle of
 * a pipeline run — a card with `{{TITLE}}` printed across it, or a story silently missing its
 * figures. Catching them at setup time is the entire reason this function exists.
 */
export function validateDeck(kind: DeckKind, presentation: Presentation): DeckReport {
  const spec: DeckSpec = DECK_SPECS[kind];
  const problems: DeckProblem[] = [...checkPageSize(presentation)];
  const slides = presentation.slides;

  if (slides.length !== spec.slideCount) {
    problems.push({
      fatal: true,
      message: `expected ${spec.slideCount} slide(s), found ${slides.length}`,
    });
  }

  // Check whichever slides do exist, so a deck with the wrong count still gets useful feedback
  // about the slides it has rather than one blunt count error.
  spec.slides.forEach((required, index) => {
    // `.at()` rather than `[index]`: the index type says a slide is always there, but the deck is
    // whatever the operator built, and the count check above has already allowed for it being short.
    const slide = slides.at(index);
    if (!slide) return;
    problems.push(...checkSlide(slide, index, required));
  });

  return { kind, presentationId: presentation.presentationId, problems };
}
