// Approval-gate state for the ApprovalPanel island (S-07, FR-020).
//
// Holds nothing the server doesn't re-check: the note-length pre-check comes from
// @/lib/approval/rules, the same module the decide endpoint validates with. Extracted per
// CLAUDE.md's convention that hooks live in src/components/hooks/, and kept as a .ts file so the
// logic stays outside the .tsx that Vitest cannot collect — mirrors useSelection.ts exactly.
import { useCallback, useState } from "react";

import { MAX_NOTE_LENGTH } from "@/lib/approval/rules";
import type { ApprovalDecision, ApprovalErrorReason } from "@/types";

/** `network` covers a fetch that never produced a typed body (offline, 502 from a proxy). */
export type SubmitFailureReason = ApprovalErrorReason | "network";

export type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; reason: SubmitFailureReason; message: string };

interface DecideResponse {
  ok?: boolean;
  reason?: ApprovalErrorReason;
  message?: string;
}

export interface UseApproval {
  decision: ApprovalDecision | null;
  note: string;
  setNote: (note: string) => void;
  reviewing: boolean;
  /** Sets the decision the review dialog is about and opens it. */
  startReview: (decision: ApprovalDecision) => void;
  cancelReview: () => void;
  submit: SubmitState;
  confirm: () => Promise<void>;
}

export function useApproval(digestId: string): UseApproval {
  const [decision, setDecision] = useState<ApprovalDecision | null>(null);
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });

  const startReview = useCallback((next: ApprovalDecision) => {
    setDecision(next);
    setReviewing(true);
  }, []);

  const cancelReview = useCallback(() => {
    setReviewing(false);
  }, []);

  const confirm = useCallback(async () => {
    if (!decision) return;

    // Mirrors the server's own check (record_approval's AG003) so a note pasted past the
    // textarea's maxLength -- or set programmatically -- fails locally rather than spending a
    // round trip on a request the database would refuse anyway.
    const trimmedNote = note.trim();
    if (trimmedNote.length > MAX_NOTE_LENGTH) {
      setSubmit({
        status: "error",
        reason: "invalid_request",
        message: `note must be ${String(MAX_NOTE_LENGTH)} characters or fewer`,
      });
      return;
    }

    setSubmit({ status: "submitting" });

    let response: Response;
    try {
      response = await fetch("/api/approval/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digestId, decision, note: trimmedNote || undefined }),
      });
    } catch {
      setSubmit({ status: "error", reason: "network", message: "Could not reach the server." });
      return;
    }

    if (response.ok) {
      // The server owns what a decided digest looks like, so re-render from it rather than
      // reproducing the post-decision view in client state.
      window.location.reload();
      return;
    }

    const body = (await response.json().catch(() => null)) as DecideResponse | null;
    setSubmit({
      status: "error",
      reason: body?.reason ?? "network",
      message: body?.message ?? `The request failed (${String(response.status)}).`,
    });
  }, [digestId, decision, note]);

  return { decision, note, setNote, reviewing, startReview, cancelReview, submit, confirm };
}
