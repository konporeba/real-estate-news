// Request state for the WeekActions island: which action the operator is confirming, and the
// POST to /api/digest/action. Mirrors usePublish.ts's shape; the caller decides what a success
// means for its page (the list refetches, the week page reloads or leaves).
import { useCallback, useState } from "react";

import type { WeekAction } from "@/lib/digest/week-actions";
import type { WeekRow } from "@/lib/digest/week-list";

export interface WeekActionDone {
  action: WeekAction;
  /** The week after the action; null once deleted. */
  week: WeekRow | null;
  warning?: string;
}

interface ActionResponse {
  ok?: boolean;
  message?: string;
  week?: WeekRow | null;
  warning?: string;
}

export type ActionState = { status: "idle" } | { status: "submitting" } | { status: "error"; message: string };

export interface UseWeekAction {
  confirming: WeekAction | null;
  state: ActionState;
  ask: (action: WeekAction) => void;
  cancel: () => void;
  confirm: () => Promise<void>;
}

export function useWeekAction(digestId: string, onDone: (done: WeekActionDone) => void): UseWeekAction {
  const [confirming, setConfirming] = useState<WeekAction | null>(null);
  const [state, setState] = useState<ActionState>({ status: "idle" });

  const ask = useCallback((action: WeekAction) => {
    setState({ status: "idle" });
    setConfirming(action);
  }, []);

  const cancel = useCallback(() => {
    setConfirming(null);
  }, []);

  const confirm = useCallback(async () => {
    if (!confirming) return;
    setState({ status: "submitting" });

    let response: Response;
    try {
      response = await fetch("/api/digest/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digestId, action: confirming }),
      });
    } catch {
      setState({ status: "error", message: "Could not reach the server. Check your connection and try again." });
      return;
    }

    const body = (await response.json().catch(() => ({}))) as ActionResponse;
    if (!response.ok || !body.ok) {
      setState({ status: "error", message: body.message ?? "Something went wrong. Please try again." });
      return;
    }

    const action = confirming;
    setConfirming(null);
    setState({ status: "idle" });
    onDone({ action, week: body.week ?? null, warning: body.warning });
  }, [confirming, digestId, onDone]);

  return { confirming, state, ask, cancel, confirm };
}
