// WORKER-SIDE, but pure: no network, no credentials, no clock.
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
