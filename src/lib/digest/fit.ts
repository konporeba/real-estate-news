// SHARED, and pure: no network, no credentials, no clock. The renderer sizes slide text with it,
// and the approval page's text editor checks an edit against it before saving — one set of limits,
// so an edit the editor accepts is one the renderer can fit. (Moved from src/lib/visuals/, which the
// app may not import.)
//
// WHY THIS EXISTS AT ALL. Google Slides has a perfectly good "shrink text on overflow" autofit,
// and the operator can switch it on in the deck — but it does not survive us. The API resets
// `autofit` to NONE and returns the font scale to default on any request that might affect text
// fitting, and `replaceAllText` always might. So the box the operator sized by eye around
// `{{TITLE}}` would keep whatever point size they typed it at, and a long Polish headline would
// silently spill out of the frame or off the card entirely.
//
// The replacement is deliberately the dumbest thing that works: count the characters, step the
// font size down through a fixed table, and refuse past the end of it. No text measurement, no
// font metrics, no rendering. Character count is a coarse proxy for width, which is exactly why
// the tiers are conservative and why `TITLE_SIZE_TIERS` is exported — Phase 7 recalibrates it
// against real generated titles by editing one table, with no call site to touch.
import type { VisualResult } from "@/types";

/** One step of the ladder: a title this long or shorter is set at this size. */
export interface TitleSizeTier {
  /** Inclusive upper bound on the title's length, in characters. */
  maxChars: number;
  /** Font size to apply, in points. */
  pointSize: number;
}

/**
 * The ladder, shortest title first. Point sizes are relative to the deck's page size: a
 * 1080 x 1080 px page is 810 x 810 pt, so 48 pt is roughly 6% of the card's height — a headline,
 * not a caption.
 *
 * Sized for the S-05 prompt's headline bound rather than for arbitrary text. Titles that reach
 * the bottom rungs are already unusual; anything past the last one is a generation problem, and
 * shrinking further would produce a card nobody can read on a phone anyway.
 */
export const TITLE_SIZE_TIERS: readonly TitleSizeTier[] = [
  { maxChars: 40, pointSize: 48 },
  { maxChars: 55, pointSize: 42 },
  { maxChars: 70, pointSize: 36 },
  { maxChars: 90, pointSize: 30 },
  { maxChars: 110, pointSize: 26 },
];

/** The longest title any tier accepts. Past this, {@link fitTitle} fails. */
export const TITLE_MAX_CHARS = TITLE_SIZE_TIERS.at(-1)?.maxChars ?? 0;

/**
 * The length the ladder is indexed by.
 *
 * Whitespace is collapsed first so a stray double space or a line break the model emitted does not
 * cost the title a tier — Slides re-wraps the text anyway, so those characters occupy no width.
 * Counted in code points rather than UTF-16 units (`Array.from`, not `.length`): nothing in Polish
 * is a surrogate pair today, but a stray emoji would otherwise count double and shrink the headline
 * for no reason.
 */
export function titleLength(title: string): number {
  return Array.from(title.trim().replace(/\s+/g, " ")).length;
}

/**
 * Decide the point size for one headline.
 *
 * Fails loudly rather than clamping to the smallest tier: a title past the ladder means the card
 * would be wrong however it is set, and the operator is better served by a number they can act on
 * ("133 characters") than by an unreadable image they have to notice for themselves.
 */
export function fitTitle(title: string): VisualResult<number> {
  const length = titleLength(title);
  if (length === 0) {
    return { ok: false, reason: "empty_title", message: "the story's Polish title is blank" };
  }

  for (const tier of TITLE_SIZE_TIERS) {
    if (length <= tier.maxChars) return { ok: true, data: tier.pointSize };
  }

  return {
    ok: false,
    reason: "title_too_long",
    message:
      `the title is ${String(length)} characters; the smallest tier fits ${String(TITLE_MAX_CHARS)}: ` +
      `"${title.trim().slice(0, 80)}"`,
  };
}

// --- Carousel: one shared box, two paragraphs ---------------------------------------------------
//
// The carousel's story slide holds the headline and the description in ONE box (see
// template-spec), so the question is not "how long is the title" but "do both paragraphs fit the
// box together". Still no font metrics: each paragraph's line count is estimated from an average
// glyph width, and the pair of sizes steps down until the estimated height fits.
//
// Calibrated on 2026-10-31 against a real render in the operator's deck (Arial, box 722 x 489 px
// on the 1080 x 1350 page): a 98-character headline at 32 pt wrapped to 4 lines and a
// 107-character description at 22 pt to 3, together 277 pt tall — which this model reproduces.

/** The shared box, in points (the page is 1080 px = 810 pt wide). */
export const CAROUSEL_BOX_PT = { width: 541.5, height: 366.75 } as const;

/** Average glyph width as a fraction of the font size: bold Arial headline, regular description. */
const TITLE_GLYPH_EM = 0.51;
const DESCRIPTION_GLYPH_EM = 0.47;
/** Word wrapping leaves the end of most lines empty; count only this share of the width as usable. */
const WRAP_EFFICIENCY = 0.88;
/** Line height as a multiple of the font size: Arial's ~1.15 times the deck's 110% / 140% spacing. */
const TITLE_LINE_EM = 1.15 * 1.1;
const DESCRIPTION_LINE_EM = 1.15 * 1.4;
/** The deck's space above the description paragraph. */
const PARAGRAPH_GAP_PT = 8;

/** One step of the carousel ladder: both paragraphs' sizes, tried in order. */
export interface CarouselSizeTier {
  titlePt: number;
  descriptionPt: number;
}

/**
 * Largest first. The title steps down before the description does, because the headline has more
 * size to give; the smallest rung is still readable on a phone at 1080 px.
 */
export const CAROUSEL_SIZE_TIERS: readonly CarouselSizeTier[] = [
  { titlePt: 32, descriptionPt: 22 },
  { titlePt: 28, descriptionPt: 22 },
  { titlePt: 28, descriptionPt: 20 },
  { titlePt: 24, descriptionPt: 20 },
  { titlePt: 24, descriptionPt: 18 },
];

function estimatedLines(text: string, pointSize: number, glyphEm: number): number {
  const perLine = Math.floor((CAROUSEL_BOX_PT.width * WRAP_EFFICIENCY) / (pointSize * glyphEm));
  return Math.max(1, Math.ceil(titleLength(text) / perLine));
}

/** The estimated height, in points, of both paragraphs at one tier. */
export function estimatedCarouselHeight(title: string, description: string, tier: CarouselSizeTier): number {
  const titleHeight = estimatedLines(title, tier.titlePt, TITLE_GLYPH_EM) * tier.titlePt * TITLE_LINE_EM;
  const descriptionHeight =
    estimatedLines(description, tier.descriptionPt, DESCRIPTION_GLYPH_EM) * tier.descriptionPt * DESCRIPTION_LINE_EM;
  return titleHeight + PARAGRAPH_GAP_PT + descriptionHeight;
}

/**
 * Decide both paragraphs' sizes for one carousel story.
 *
 * Fails, like {@link fitTitle}, rather than shrinking past the last tier: text that does not fit
 * at 24/18 pt is a generation problem, and the operator is better served by the story's name and
 * character counts than by an image with text running off the panel.
 */
export function fitCarouselText(title: string, description: string): VisualResult<CarouselSizeTier> {
  if (titleLength(title) === 0) {
    return { ok: false, reason: "empty_title", message: "the story's Polish title is blank" };
  }
  if (titleLength(description) === 0) {
    return { ok: false, reason: "empty_description", message: "the story's caption summary is blank" };
  }

  for (const tier of CAROUSEL_SIZE_TIERS) {
    if (estimatedCarouselHeight(title, description, tier) <= CAROUSEL_BOX_PT.height) return { ok: true, data: tier };
  }

  return {
    ok: false,
    reason: "text_too_long",
    message:
      `title (${String(titleLength(title))} characters) and description (${String(titleLength(description))} ` +
      `characters) do not fit the slide even at the smallest sizes: "${title.trim().slice(0, 80)}"`,
  };
}
