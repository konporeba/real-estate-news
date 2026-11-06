// Request state for the StartRunButton island. A successful start reloads the dashboard, which then
// shows the new week on its "this week" card.
import { useCallback, useState } from "react";

export type StartRunState = { status: "idle" } | { status: "starting" } | { status: "error"; message: string };

export interface UseStartRun {
  state: StartRunState;
  reset: () => void;
  start: () => Promise<void>;
}

export function useStartRun(): UseStartRun {
  const [state, setState] = useState<StartRunState>({ status: "idle" });

  const reset = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  const start = useCallback(async () => {
    setState({ status: "starting" });
    let response: Response;
    try {
      response = await fetch("/api/digest/start", { method: "POST" });
    } catch {
      setState({ status: "error", message: "Could not reach the server. Check your connection and try again." });
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!response.ok || !body.ok) {
      setState({ status: "error", message: body.message ?? "Something went wrong. Please try again." });
      return;
    }
    window.location.reload();
  }, []);

  return { state, reset, start };
}
