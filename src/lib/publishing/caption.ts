// SHARED, runtime-neutral: no LLM call, no environment, no Supabase client. Builds the one caption
// a multi-story post needs from each selected story's already-generated `caption_summary` (S-05)
// verbatim, per the plan's confirmed decision not to spend a new generation call on this.

/** Separates story summaries in a multi-story caption, so each remains visually distinct. */
const SEPARATOR = "\n\n---\n\n";

/** Appended when a caption is truncated, so it never reads as if it simply ended. */
const ELLIPSIS = "…";

/**
 * Join already-ordered story summaries into one caption. Callers (Phase 3's `runPublish`) are
 * responsible for the ordering — this function does not query anything or decide story order.
 */
export function composeCaption(summaries: readonly string[]): string {
  return summaries.join(SEPARATOR);
}

/**
 * Truncate a caption to a platform's own length limit, ending with an ellipsis rather than a
 * mid-word cut wherever a preceding space makes that possible within the last 20 characters.
 * A caption already within the limit is returned unchanged.
 */
export function truncateForPlatform(caption: string, maxLength: number): string {
  if (caption.length <= maxLength) return caption;

  const budget = maxLength - ELLIPSIS.length;
  if (budget <= 0) return ELLIPSIS.slice(0, maxLength);

  const cut = caption.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > budget - 20 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed}${ELLIPSIS}`;
}
