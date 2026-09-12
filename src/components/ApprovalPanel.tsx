// The content approval gate's operator UI (S-07, FR-020, US-16) — the app's second hydrated
// island, mirroring SelectionForm's shape exactly.
//
// It hydrates for the same reason SelectionForm does: the transition is irreversible (`approved`
// has no way back to `ready_for_approval`, and `rejected` only recovers through a fresh
// generation run) and unattended publishing follows an approval, so a review step stands between
// the buttons and the transition. Everything it enforces is re-enforced by the endpoint and again
// by record_approval(); this layer is the affordance, not the gate.
import { useState } from "react";

import { useApproval } from "@/components/hooks/useApproval";
import { MAX_NOTE_LENGTH } from "@/lib/approval/rules";
import { FORMAT_LABELS, PLATFORM_LABELS } from "@/lib/selection/rules";
import { cn } from "@/lib/utils";
import type { SelectionFormat, SelectionPlatform } from "@/types";

export interface ApprovalPanelProps {
  digestId: string;
  storyCount: number;
  format: SelectionFormat;
  platforms: SelectionPlatform[];
}

const APPROVE_BUTTON =
  "rounded-lg bg-green-500 px-4 py-2 font-semibold text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-green-500";
const REJECT_BUTTON =
  "rounded-lg bg-red-500/90 px-4 py-2 font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-red-500/90";
const SECONDARY_BUTTON =
  "rounded-lg border border-white/20 bg-white/5 px-4 py-2 font-semibold text-blue-100/80 transition-colors hover:bg-white/10";

export function ApprovalPanel({ digestId, storyCount, format, platforms }: ApprovalPanelProps) {
  const approval = useApproval(digestId);
  const busy = approval.submit.status === "submitting";
  const [noteTouched, setNoteTouched] = useState(false);
  const noteTooLong = approval.note.trim().length > MAX_NOTE_LENGTH;

  return (
    <div className="sticky top-0 z-10 mb-4 rounded-xl border border-white/10 bg-slate-900/80 p-4 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Decide on this week’s post</p>
          <p className="text-xs text-blue-100/60">Approving publishes this content; this cannot be undone.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={APPROVE_BUTTON}
            disabled={busy}
            onClick={() => {
              approval.startReview("approved");
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className={REJECT_BUTTON}
            disabled={busy}
            onClick={() => {
              approval.startReview("rejected");
            }}
          >
            Reject
          </button>
        </div>
      </div>

      {approval.submit.status === "error" && (
        <div className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
          <p>{approval.submit.message}</p>
        </div>
      )}

      {approval.reviewing && approval.decision && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={approval.decision === "approved" ? "Confirm approval" : "Confirm rejection"}
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-white/15 bg-slate-900 p-6 text-white shadow-xl">
            {approval.decision === "approved" ? (
              <>
                <h2 className="text-lg font-semibold">Approve this week’s post</h2>
                <p className="mt-1 text-sm text-blue-100/70">
                  {storyCount} {storyCount === 1 ? "story" : "stories"} will publish as{" "}
                  {FORMAT_LABELS[format].toLowerCase()} content for{" "}
                  {platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}. This cannot be undone.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold">Reject this week’s post</h2>
                <p className="mt-1 text-sm text-blue-100/70">
                  Nothing will publish. You can regenerate fresh copy for the same picks afterward.
                </p>
                <label htmlFor="approval-note" className="mt-4 block text-xs tracking-wide text-blue-100/60 uppercase">
                  Note (optional)
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
                  placeholder="What should change?"
                  className="mt-2 w-full rounded-lg border border-white/15 bg-white/5 p-3 text-sm text-white placeholder:text-blue-100/40"
                />
                {noteTouched && noteTooLong && (
                  <p className="mt-1 text-xs text-red-300">note must be {MAX_NOTE_LENGTH} characters or fewer</p>
                )}
              </>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={approval.cancelReview}>
                Back
              </button>
              <button
                type="button"
                className={cn(approval.decision === "approved" ? APPROVE_BUTTON : REJECT_BUTTON)}
                disabled={busy || noteTooLong}
                onClick={() => {
                  // On success the page reloads and this never runs; on failure the dialog must
                  // close, or the error banner it produced sits hidden behind this overlay.
                  void approval.confirm().then(() => {
                    approval.cancelReview();
                  });
                }}
              >
                {busy ? "Saving…" : approval.decision === "approved" ? "Confirm approval" : "Confirm rejection"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
