// The content approval gate's operator UI (S-07, FR-020, US-16) — the app's second hydrated
// island, mirroring SelectionForm's shape exactly.
//
// It hydrates for the same reason SelectionForm does: the transition is irreversible (`approved`
// has no way back to `ready_for_approval`, and `rejected` only recovers through a fresh
// generation run) and unattended publishing follows an approval, so a review step stands between
// the buttons and the transition. Everything it enforces is re-enforced by the endpoint and again
// by record_approval(); this layer is the affordance, not the gate.
//
// Drawn as a bar fixed to the bottom of the screen, so the decision stays in reach however far
// down the copy the operator has read.
import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useApproval } from "@/components/hooks/useApproval";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { MAX_NOTE_LENGTH } from "@/lib/approval/rules";
import { FORMAT_LABELS, PLATFORM_LABELS } from "@/lib/selection/rules";
import type { SelectionFormat, SelectionPlatform } from "@/types";

export interface ApprovalPanelProps {
  digestId: string;
  storyCount: number;
  format: SelectionFormat;
  platforms: SelectionPlatform[];
}

export function ApprovalPanel({ digestId, storyCount, format, platforms }: ApprovalPanelProps) {
  const approval = useApproval(digestId);
  const busy = approval.submit.status === "submitting";
  const [noteTouched, setNoteTouched] = useState(false);
  const noteTooLong = approval.note.trim().length > MAX_NOTE_LENGTH;
  const approving = approval.decision === "approved";

  return (
    <div className="bg-card fixed inset-x-0 bottom-0 z-10 border-t shadow-[0_-8px_24px_rgb(15_23_42/0.06)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6">
        {approval.submit.status === "error" && (
          <p
            role="alert"
            className="border-destructive bg-destructive-tint text-destructive rounded-xl border p-3 text-sm"
          >
            {approval.submit.message}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-base font-semibold">Approve, and it publishes on Tuesday at 17:00</p>
            <p className="text-muted-foreground text-sm">Nothing is posted without your approval.</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => {
                approval.startReview("rejected");
              }}
            >
              Send back for rewrite
            </button>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={busy}
              onClick={() => {
                approval.startReview("approved");
              }}
            >
              Approve post
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={approval.reviewing && approval.decision !== null}
        title={approving ? "Approve this week's post?" : "Send this post back?"}
        busy={busy}
        confirmDisabled={!approving && noteTooLong}
        confirmLabel={busy ? "Saving…" : approving ? "Approve post" : "Send back"}
        onCancel={approval.cancelReview}
        onConfirm={() => {
          void approval.confirm().then(() => {
            approval.cancelReview();
          });
        }}
      >
        {approving ? (
          <p className="text-muted-foreground text-[15px] leading-relaxed">
            {storyCount} {storyCount === 1 ? "story" : "stories"} will publish as {FORMAT_LABELS[format].toLowerCase()}{" "}
            content for {platforms.map((p) => PLATFORM_LABELS[p]).join(", ")} on Tuesday at 17:00. This can’t be undone.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-[15px] leading-relaxed">
              Nothing will be published. Fresh copy can be generated for the same picks afterwards.
            </p>
            <label htmlFor="approval-note" className="mt-4 block text-sm font-semibold">
              What should change? <span className="text-muted-foreground font-normal">Optional</span>
            </label>
            <textarea
              id="approval-note"
              rows={3}
              maxLength={MAX_NOTE_LENGTH}
              value={approval.note}
              onChange={(event) => {
                setNoteTouched(true);
                approval.setNote(event.target.value);
              }}
              placeholder="e.g. The second headline is too long"
              className="border-input bg-card placeholder:text-muted-foreground mt-2 w-full rounded-xl border p-3 text-[15px]"
            />
            {noteTouched && noteTooLong && (
              <p className="text-destructive mt-1 text-sm">Keep the note to {MAX_NOTE_LENGTH} characters or fewer.</p>
            )}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
