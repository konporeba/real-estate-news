// WORKER-SIDE, but pure: no network, no credentials, no clock.
//
// One story's generated copy in, one map of placeholder name -> replacement text out. Keys are
// placeholder NAMES ("TITLE"), not tokens ("{{TITLE}}") — `token()` in template.ts owns the brace
// syntax, and having one module know it keeps a future change to the delimiters from rippling.
//
// Two maps: `buildSlotMap` for the single-post slide (headline + three statistics) and
// `buildCarouselSlots` for the carousel story slide (headline + description, no statistics).
//
// The interesting decision for single-post is that a story with too few figures FAILS rather than rendering
// with a gap. Slides cannot hide an element through the API, so an unfilled `{{STAT_3_VALUE}}`
// would publish either as a literal `{{STAT_3_VALUE}}` or as an empty pill sitting in the layout.
// A digest that stops with a diagnostic is recoverable in minutes; a card that looks finished and
// is not reaches the approval gate looking publishable.
import { STORY_PLACEHOLDERS } from "@/lib/visuals/template";
import type { GeneratedCopyRow, KeyStatistic, VisualResult } from "@/types";

/**
 * How many figures the story template has room for. Fixed, not variable: see the module note.
 * Generation produces three to five (`KEY_STATISTICS_MIN`/`MAX`), so the first three are taken and
 * the rest are dropped — they live on in `generated_copy` for the archive.
 */
export const STAT_SLOT_COUNT = 3;

/** Placeholder names for one statistic slot, 1-based to match the deck's `{{STAT_1_LABEL}}`. */
export function statPlaceholders(index: number): { label: string; value: string } {
  return { label: `STAT_${String(index)}_LABEL`, value: `STAT_${String(index)}_VALUE` };
}

/**
 * Read `generated_copy.key_statistics` back into its declared shape.
 *
 * The column is `jsonb` and typed `Json`, so nothing has checked it since the generation schema
 * validated it on the way in. Rather than trust that, every element is re-checked here and
 * anything malformed is reported as such — this is the only reader, and a silent `undefined`
 * flowing into a slot would surface as a blank card rather than an error.
 */
export function parseKeyStatistics(raw: GeneratedCopyRow["key_statistics"]): VisualResult<KeyStatistic[]> {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      reason: "malformed_statistics",
      message: "key_statistics is not an array",
    };
  }

  const statistics: KeyStatistic[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "malformed_statistics", message: "key_statistics holds a non-object entry" };
    }
    const { label, value } = entry;
    if (typeof label !== "string" || typeof value !== "string") {
      return {
        ok: false,
        reason: "malformed_statistics",
        message: "a key_statistics entry is missing a string `label` or `value`",
      };
    }
    statistics.push({ label, value });
  }
  return { ok: true, data: statistics };
}

/**
 * Map one story onto the story slide's placeholder vocabulary.
 *
 * Blank labels and values are dropped before the count is checked, because a figure that renders
 * as nothing is not a figure — counting it would let an empty pill through on a technicality.
 */
export function buildSlotMap(copy: GeneratedCopyRow): VisualResult<Record<string, string>> {
  const title = copy.polish_title.trim();
  if (!title) {
    return { ok: false, reason: "empty_title", message: "the story's Polish title is blank" };
  }

  const parsed = parseKeyStatistics(copy.key_statistics);
  if (!parsed.ok) return parsed;

  const usable = parsed.data
    .map((statistic) => ({ label: statistic.label.trim(), value: statistic.value.trim() }))
    .filter((statistic) => statistic.label !== "" && statistic.value !== "");

  if (usable.length < STAT_SLOT_COUNT) {
    return {
      ok: false,
      reason: "insufficient_statistics",
      message:
        `the story has ${String(usable.length)} usable key statistic(s); the template has ` +
        `${String(STAT_SLOT_COUNT)} fixed slots and Slides cannot hide the unfilled ones`,
    };
  }

  const slots: Record<string, string> = { TITLE: title };
  usable.slice(0, STAT_SLOT_COUNT).forEach((statistic, index) => {
    const names = statPlaceholders(index + 1);
    slots[names.label] = statistic.label;
    slots[names.value] = statistic.value;
  });

  return { ok: true, data: slots };
}

/**
 * Map one story onto the carousel story slide: the headline and the caption summary, which share
 * one text box (see template.ts). No statistics — the carousel design has no slots for them; they
 * stay in `generated_copy` for the archive.
 *
 * Whitespace is collapsed to single spaces: a line break the model emitted inside a caption would
 * otherwise become a third paragraph and shift the ranges the renderer sizes.
 */
export function buildCarouselSlots(copy: GeneratedCopyRow): VisualResult<{ TITLE: string; DESCRIPTION: string }> {
  const title = copy.polish_title.trim().replace(/\s+/g, " ");
  if (!title) return { ok: false, reason: "empty_title", message: "the story's Polish title is blank" };

  const description = copy.caption_summary.trim().replace(/\s+/g, " ");
  if (!description) {
    return { ok: false, reason: "empty_description", message: "the story's caption summary is blank" };
  }

  return { ok: true, data: { TITLE: title, DESCRIPTION: description } };
}

/** Re-exported so the orchestrator and its tests reference one definition of the vocabulary. */
export { STORY_PLACEHOLDERS };
