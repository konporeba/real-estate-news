// WORKER-SIDE. FR-014's numeric-integrity gate: extract the significant figures from a story's
// source text, and assert every one of them survived into the generated Polish copy.
//
// This is a DETERMINISTIC check that runs AFTER the model, not a promise made to it in a prompt.
// US-12 is explicit: if a figure is missing or altered, the run fails rather than publishing
// wrong numbers to investors. The prompt still asks the model to carry figures through — but the
// prompt is the optimistic path and this module is the enforcement.
//
// Two design decisions drive everything below.
//
// SIGNIFICANT FIGURES ONLY. A bare number in prose is ignored; a number counts only when it
// carries a currency symbol, a percent sign, a unit, or a magnitude word. Those are the classes
// FR-014 names — prices, percentages, dates. Policing every digit would fail on bylines, article
// ids and "5 min de lectura", and a gate that fails good runs is a gate that gets switched off.
//
// COMPARISON IS ON VALUE, NOT FORMATTING. Spanish and Polish format numbers differently
// (`1.234,56 €` vs `1 234,56 zł`) and scale them with different words (`3,5 millones` vs
// `3,5 mln`). Both sides are normalized to a canonical number before comparison, so legitimate
// localisation passes and genuine drift (1.234 -> 1.243) fails.

/**
 * What made a number significant.
 *
 * `magnitude` covers both a scale word (`millones`, `mln`) and a unit (`m²`, `km`) — in each case
 * the number is significant because something qualifies it, and the distinction does not change
 * how the gate treats it.
 */
export type FigureKind = "currency" | "percentage" | "magnitude";

export interface Figure {
  /** The number exactly as it appeared, for diagnostics in `last_error`. */
  raw: string;
  /** Canonical value, with any magnitude word already applied (`3,5 millones` -> 3_500_000). */
  value: number;
  kind: FigureKind;
}

export type FigureCheck = { ok: true } | { ok: false; missing: Figure[] };

/**
 * A number, in any of the shapes Spanish, Catalan and Polish prose produce.
 *
 * The grouped alternative comes FIRST and requires exactly three digits after each separator, so
 * `1.234` reads as Spanish thousands (1234) while `3.5` falls through to the second alternative
 * and reads as a decimal. Order is load-bearing: with the alternatives swapped, `\d+` would match
 * `1` in `1.234` and the rest would be lost.
 *
 * Separators include NBSP (U+00A0), narrow NBSP (U+202F) and thin space (U+2009) — Polish
 * typography uses all three inside numbers, and a plain `\s` class would miss them.
 */
const NUMBER_RE = /\d{1,3}(?:[.\u00A0\u202F\u2009 ]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g;

/** All separator characters that can appear *inside* a number. */
const GROUP_SEPARATORS = /[.\u00A0\u202F\u2009 ]/g;

/** Currency markers, on either side of the number. Polish and Spanish/Catalan both covered. */
const CURRENCY = /€|\$|z[łl]|EUR|PLN|USD|euros?|złot[a-ząćęłńóśźż]*/i;

/** Percent, written as a symbol or spelled out in either language. */
const PERCENT = /%|por\s+ciento|per\s+cent|procent[a-ząćęłńóśźż]*/i;

/**
 * Magnitude words and their multipliers, longest-stem first so `millones` is tested before `mil`
 * — otherwise `3 millones` would scale by a thousand.
 *
 * Stems rather than exact words on purpose: Polish inflects heavily (`milion`, `miliona`,
 * `milionów`, `milionami`) and matching the stem covers every case without enumerating them.
 * Spanish `mil millones` (10^9) is handled by testing the compound before the bare `mil`.
 */
const MAGNITUDES: { pattern: RegExp; multiplier: number }[] = [
  { pattern: /^mil\s+millon/i, multiplier: 1_000_000_000 },
  { pattern: /^mil\s+milion/i, multiplier: 1_000_000_000 },
  { pattern: /^(?:miliard|mld\b)/i, multiplier: 1_000_000_000 },
  { pattern: /^(?:millon|millón|milion|milió|mln\b)/i, multiplier: 1_000_000 },
  { pattern: /^(?:tysi|tys\b|tys\.)/i, multiplier: 1_000 },
  { pattern: /^(?:mil\b|milers\b)/i, multiplier: 1_000 },
];

/**
 * Units that make a bare number significant — areas and distances, which prices hang off.
 *
 * Both the abbreviated and the spelled-out form of each: real article text mixes them freely
 * ("un vano principal de 853 metros" alongside "2,5 kilómetros de longitud"), and covering only
 * the abbreviations silently drops half the figures a story actually reports.
 */
const UNIT = /^(?:m²|m2|km²|km2|km|ha|hect[áa]re|kil[óo]metr|metr|mkw)/i;

/**
 * Connectors that join the two ends of a range. `entre 1.000 y 2.000 €` must yield BOTH figures:
 * only the second carries the currency marker, so the first inherits it. Covers Spanish (`y`,
 * `a`), Catalan (`i`), Polish (`do`, `i`) and bare dashes.
 */
const RANGE_CONNECTOR = /^\s*(?:y|a|i|do|-|–|—)\s*$/i;

/** How much text around a number to inspect when classifying it. */
const LOOKAHEAD = 24;
const LOOKBEHIND = 12;

/**
 * Parse a matched number into its numeric value.
 *
 * A comma is ALWAYS the decimal separator — true in Spanish, Catalan and Polish alike. Anything
 * else inside the number is a thousands separator and is simply removed. A lone dot is a decimal
 * point only when it is not a thousands group (`3.5`), which the caller's regex has already
 * distinguished by requiring exactly three digits for a group.
 */
function parseNumber(raw: string): number {
  const commaAt = raw.lastIndexOf(",");
  if (commaAt !== -1) {
    const whole = raw.slice(0, commaAt).replace(GROUP_SEPARATORS, "");
    const fraction = raw.slice(commaAt + 1);
    return Number(`${whole}.${fraction}`);
  }

  // No comma: a dot followed by exactly three digits (one or more times) is grouping, anything
  // else is a decimal point.
  if (/^\d{1,3}(?:[.\u00A0\u202F\u2009 ]\d{3})+$/.test(raw)) {
    return Number(raw.replace(GROUP_SEPARATORS, ""));
  }
  return Number(raw.replace(/[\u00A0\u202F\u2009 ]/g, ""));
}

/** The magnitude multiplier a suffix implies, or 1 when it names none. */
function magnitudeOf(after: string): number {
  const trimmed = after.replace(/^[\s\u00A0\u202F\u2009]+/, "");
  for (const { pattern, multiplier } of MAGNITUDES) {
    if (pattern.test(trimmed)) return multiplier;
  }
  return 1;
}

interface Candidate {
  raw: string;
  value: number;
  kind: FigureKind | null;
  /** Index just past this number, used to test range connectors between neighbours. */
  end: number;
  start: number;
}

/**
 * Classify one number from the text around it. Returns `null` for `kind` when nothing qualifies
 * it — the number is then insignificant and dropped, unless a range connector later lends it the
 * qualifier of its neighbour.
 */
function classify(text: string, match: RegExpExecArray): Candidate {
  const raw = match[0];
  const start = match.index;
  const end = start + raw.length;
  const before = text.slice(Math.max(0, start - LOOKBEHIND), start);
  const after = text.slice(end, end + LOOKAHEAD);

  const base = parseNumber(raw);
  const multiplier = magnitudeOf(after);

  // Percent first: `%` binds tighter than anything else and a percentage is never a price.
  if (PERCENT.test(after.slice(0, 12).replace(/^[\s\u00A0\u202F\u2009]+/, ""))) {
    return { raw, value: base, kind: "percentage", start, end };
  }

  // A magnitude word scales the value, so `3,5 millones` and `3 500 000` compare equal. It may
  // still be a currency amount (`3,5 millones de euros`) — currency wins as the kind when a
  // marker follows, but either way the multiplier applies.
  if (multiplier > 1) {
    const kind: FigureKind = CURRENCY.test(after) || CURRENCY.test(before) ? "currency" : "magnitude";
    return { raw, value: base * multiplier, kind, start, end };
  }

  // Currency on either side: `1.234 €` and `€1.234` are the same figure.
  const currencyAfter = after.replace(/^[\s\u00A0\u202F\u2009]+/, "");
  const currencyBefore = before.replace(/[\s\u00A0\u202F\u2009]+$/, "");
  if (
    new RegExp(`^(?:${CURRENCY.source})`, "i").test(currencyAfter) ||
    new RegExp(`(?:${CURRENCY.source})$`, "i").test(currencyBefore)
  ) {
    return { raw, value: base, kind: "currency", start, end };
  }

  if (UNIT.test(after.replace(/^[\s\u00A0\u202F\u2009]+/, ""))) {
    return { raw, value: base, kind: "magnitude", start, end };
  }

  return { raw, value: base, kind: null, start, end };
}

/**
 * Give an unqualified number the qualifier of the number it is ranged against.
 *
 * `entre 1.000 y 2.000 €` carries the currency marker only after the second number, but both ends
 * of the range are figures the copy must preserve. Inheritance runs right-to-left because the
 * qualifier trails the range.
 */
function inheritAcrossRanges(text: string, candidates: Candidate[]): void {
  for (let i = candidates.length - 2; i >= 0; i -= 1) {
    const current = candidates[i];
    const next = candidates[i + 1];
    if (current.kind !== null || next.kind === null) continue;
    if (!RANGE_CONNECTOR.test(text.slice(current.end, next.start))) continue;

    current.kind = next.kind;
    // A range shares its scale: `entre 1 y 2 millones` is 1M to 2M, not 1 to 2M.
    if (next.value !== 0 && Number.isFinite(next.value)) {
      const nextBase = parseNumber(next.raw);
      const scale = nextBase === 0 ? 1 : next.value / nextBase;
      current.value = parseNumber(current.raw) * scale;
    }
  }
}

/**
 * Every significant figure in `text`, de-duplicated by value and kind.
 *
 * De-duplication is deliberate: FR-014 requires each VALUE to survive, not each mention. An
 * article repeating "8%" three times must not force the copy to repeat it three times.
 */
export function extractFigures(text: string): Figure[] {
  if (!text) return [];

  const candidates: Candidate[] = [];
  NUMBER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_RE.exec(text)) !== null) {
    candidates.push(classify(text, match));
  }

  inheritAcrossRanges(text, candidates);

  const seen = new Set<string>();
  const figures: Figure[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === null) continue;
    if (!Number.isFinite(candidate.value)) continue;
    const key = `${candidate.kind}:${String(candidate.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    figures.push({ raw: candidate.raw, value: candidate.value, kind: candidate.kind });
  }
  return figures;
}

/**
 * Values are compared with a relative epsilon rather than `===`: normalization goes through
 * floating-point arithmetic (`3,5 * 1_000_000`), and an exact comparison would reject figures
 * that differ only in the last representable bit.
 */
function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9);
}

/**
 * FR-014's assertion: every source figure must appear in the generated output.
 *
 * Matching is on canonical VALUE only, ignoring kind — a Spanish `3,5 millones de euros` may
 * legitimately become a Polish `3,5 mln zł`, and demanding the kind also match would fail on a
 * correct translation. What cannot change is the number itself.
 *
 * A figure that drifted (1.234 -> 1.243) reports as missing, because no output figure carries its
 * value; that is the failure US-12 exists to catch.
 */
export function assertFiguresPresent(source: Figure[], output: string): FigureCheck {
  if (source.length === 0) return { ok: true };

  const present = extractFigures(output).map((figure) => figure.value);
  const missing = source.filter((figure) => !present.some((value) => sameValue(value, figure.value)));

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** One-line diagnostic for `digest.last_error` when the gate fails. */
export function describeMissing(missing: Figure[]): string {
  return missing.map((figure) => `${figure.raw} (${figure.kind}, ${String(figure.value)})`).join("; ");
}
