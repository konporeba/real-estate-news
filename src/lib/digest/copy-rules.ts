// The rules for the operator's text edits on the approval page: the request shape and whether an
// edited story still fits its slide. Pure and client-safe — the StoryEditor island checks as the
// operator types, and saveCopyEdits (edit-copy.ts) checks again before writing. Kept apart from the
// save so the island's bundle carries no database code, like src/lib/selection/rules.ts.
import { z } from "zod";

import { fitCarouselText, fitTitle } from "@/lib/digest/fit";
import type { SelectionFormat } from "@/types";

/** Generous sanity bounds; the slide's fit is the real limit and is checked separately. */
const TITLE_MAX = 300;
const CAPTION_MAX = 2000;

export const storyEditSchema = z.object({
  clusterId: z.uuid(),
  polishTitle: z.string().max(TITLE_MAX),
  captionSummary: z.string().max(CAPTION_MAX),
});

export type StoryEdit = z.infer<typeof storyEditSchema>;

export const copyEditRequestSchema = z.object({
  digestId: z.uuid(),
  stories: z.array(storyEditSchema).min(1).max(4),
});

/** The text as the slide will show it: the renderer collapses whitespace the same way (slots.ts). */
export function slideText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Why this story's edit can't be saved, in words for the operator — or null when it's fine.
 * Runs in the editor as the operator types, and again on the server before anything is written.
 */
export function storyEditProblem(
  format: SelectionFormat,
  story: Pick<StoryEdit, "polishTitle" | "captionSummary">,
): string | null {
  const title = slideText(story.polishTitle);
  const caption = slideText(story.captionSummary);
  if (!title) return "The title can't be empty.";
  if (!caption) return "The caption can't be empty.";

  if (format === "carousel") {
    return fitCarouselText(title, caption).ok
      ? null
      : "Too long to fit on the slide, even at the smallest text size. Shorten the title or the caption.";
  }
  return fitTitle(title).ok ? null : "The title is too long for the slide. Shorten it.";
}
