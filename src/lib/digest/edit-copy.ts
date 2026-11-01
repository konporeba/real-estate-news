// The operator's own edits to a story's Polish text on the approval page, before they approve.
// Only the title and caption summary are editable: they are what the slides show and what the
// published post's caption is built from. Body copy and key statistics are not on the carousel or
// in the caption, so editing them would change nothing anyone sees.
//
// Deliberately NOT held to the numeric-integrity gate (FR-014): that gate exists because the model
// may invent a figure; the operator is the authority on their own text. What IS enforced is that the
// text still fits the slide — the same rules the renderer uses (fit.ts) — so a saved edit never
// turns into a failed render. Shared code: takes its client as a parameter.
import { storyEditProblem, type StoryEdit } from "@/lib/digest/copy-rules";
import { transitionDigest } from "@/lib/digest/run-state";
import type { ServiceClient } from "@/lib/supabase-service";

export type SaveCopyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "not_allowed" | "invalid_copy" | "database_error";
      message: string;
      /** Per-story problems for `invalid_copy`, keyed by cluster id. */
      problems?: Record<string, string>;
    };

/**
 * Save the edits and send the week back to `rendering`, where the Pi redraws the slides from the
 * edited text and the approval email arrives again.
 *
 * The week moves to `rendering` BEFORE the text is written: if the operator approved in another tab
 * a moment earlier, that transition is refused and nothing is saved — an approved post never ends up
 * with text its slides don't show. A write that fails part-way leaves the week in `rendering` anyway:
 * the slides are then redrawn from whatever was saved, so text and slides still match when it comes
 * back for approval.
 */
export async function saveCopyEdits(
  client: ServiceClient,
  digestId: string,
  stories: StoryEdit[],
): Promise<SaveCopyResult> {
  const [digest, selection, copy] = await Promise.all([
    client.from("digest").select("id, status").eq("id", digestId).maybeSingle(),
    client.from("selection").select("format").eq("digest_id", digestId).maybeSingle(),
    client.from("generated_copy").select("cluster_id").eq("digest_id", digestId),
  ]);
  const readError = digest.error ?? selection.error ?? copy.error;
  if (readError) return { ok: false, reason: "database_error", message: readError.message };
  if (!digest.data) return { ok: false, reason: "not_found", message: "That week no longer exists." };
  if (digest.data.status !== "ready_for_approval") {
    return {
      ok: false,
      reason: "not_allowed",
      message: "The text can only be edited while the post waits for your approval.",
    };
  }
  if (!selection.data) return { ok: false, reason: "not_found", message: "This week has no confirmed picks." };

  const known = new Set((copy.data ?? []).map((row) => row.cluster_id));
  const problems: Record<string, string> = {};
  for (const story of stories) {
    const problem = known.has(story.clusterId)
      ? storyEditProblem(selection.data.format, story)
      : "This story isn't part of this week's post.";
    if (problem) problems[story.clusterId] = problem;
  }
  if (Object.keys(problems).length > 0) {
    return { ok: false, reason: "invalid_copy", message: "Some stories need changes before saving.", problems };
  }

  const moved = await transitionDigest(client, digestId, "rendering");
  if (!moved.ok) {
    return {
      ok: false,
      reason: "not_allowed",
      message: "This post changed while you were editing (it may have been approved). Reload the page.",
    };
  }

  for (const story of stories) {
    const { error } = await client
      .from("generated_copy")
      .update({ polish_title: story.polishTitle.trim(), caption_summary: story.captionSummary.trim() })
      .eq("digest_id", digestId)
      .eq("cluster_id", story.clusterId);
    if (error) {
      return {
        ok: false,
        reason: "database_error",
        message: `Not every edit could be saved (${error.message}). The slides are being redrawn from what was saved; check the text when the post comes back.`,
      };
    }
  }
  return { ok: true };
}
