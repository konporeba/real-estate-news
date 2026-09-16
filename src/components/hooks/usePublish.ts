// Publish-trigger state for the PublishPanel island (S-08, FR-023).
//
// Mirrors useApproval.ts's shape, with one deliberate difference: publishing has only one action
// ("Publish now", not a choice between two decisions), and a successful request renders its own
// per-platform results directly from the response rather than reloading the page — the server-owns
// precedent useApproval follows doesn't apply here, since there is no single "decided" state to
// re-render from; a partial failure is still visible and re-triggerable.
import { useCallback, useState } from "react";

import type { PublicationErrorReason, PublishSummary } from "@/types";

/** `network` covers a fetch that never produced a typed body (offline, 502 from a proxy). */
export type SubmitFailureReason = PublicationErrorReason | "network";

export type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; summary: PublishSummary }
  | { status: "error"; reason: SubmitFailureReason; message: string };

interface TriggerResponse {
  ok?: boolean;
  reason?: PublicationErrorReason;
  message?: string;
  summary?: PublishSummary;
}

export interface UsePublish {
  reviewing: boolean;
  startReview: () => void;
  cancelReview: () => void;
  submit: SubmitState;
  confirm: () => Promise<void>;
}

export function usePublish(digestId: string): UsePublish {
  const [reviewing, setReviewing] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });

  const startReview = useCallback(() => {
    setReviewing(true);
  }, []);

  const cancelReview = useCallback(() => {
    setReviewing(false);
  }, []);

  const confirm = useCallback(async () => {
    setSubmit({ status: "submitting" });

    let response: Response;
    try {
      response = await fetch("/api/publish/trigger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digestId }),
      });
    } catch {
      setSubmit({ status: "error", reason: "network", message: "Could not reach the server." });
      return;
    }

    const body = (await response.json().catch(() => null)) as TriggerResponse | null;

    if (response.ok && body?.summary) {
      setSubmit({ status: "success", summary: body.summary });
      return;
    }

    setSubmit({
      status: "error",
      reason: body?.reason ?? "network",
      message: body?.message ?? `The request failed (${String(response.status)}).`,
    });
  }, [digestId]);

  return { reviewing, startReview, cancelReview, submit, confirm };
}
