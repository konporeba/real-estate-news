// State for the StoryEditor island: the draft text per story, the live slide-fit check, and the
// save. A successful save reloads the page, which then shows the week redrawing its slides — the
// server owns what happens next, the same precedent useApproval follows.
import { useCallback, useMemo, useState } from "react";

import { storyEditProblem, type StoryEdit } from "@/lib/digest/copy-rules";
import type { SelectionFormat } from "@/types";

export type SaveState = { status: "idle" } | { status: "saving" } | { status: "error"; message: string };

interface SaveResponse {
  ok?: boolean;
  message?: string;
  problems?: Record<string, string>;
}

export interface UseStoryEditor {
  drafts: StoryEdit[];
  update: (clusterId: string, field: "polishTitle" | "captionSummary", value: string) => void;
  reset: () => void;
  /** Live per-story problems, keyed by cluster id; the server's answer replaces them after a save. */
  problems: Partial<Record<string, string>>;
  changed: boolean;
  save: SaveState;
  submit: () => Promise<void>;
}

export function useStoryEditor(digestId: string, format: SelectionFormat, original: StoryEdit[]): UseStoryEditor {
  const [drafts, setDrafts] = useState<StoryEdit[]>(original);
  const [serverProblems, setServerProblems] = useState<Record<string, string>>({});
  const [save, setSave] = useState<SaveState>({ status: "idle" });

  const update = useCallback((clusterId: string, field: "polishTitle" | "captionSummary", value: string) => {
    setDrafts((current) =>
      current.map((draft) => (draft.clusterId === clusterId ? { ...draft, [field]: value } : draft)),
    );
    setServerProblems({});
  }, []);

  const reset = useCallback(() => {
    setDrafts(original);
    setServerProblems({});
    setSave({ status: "idle" });
  }, [original]);

  const problems = useMemo(() => {
    const live: Record<string, string> = {};
    for (const draft of drafts) {
      const problem = storyEditProblem(format, draft);
      if (problem) live[draft.clusterId] = problem;
    }
    return { ...live, ...serverProblems };
  }, [drafts, format, serverProblems]);

  const changed = drafts.some((draft, i) => {
    const before = original[i];
    return draft.polishTitle !== before.polishTitle || draft.captionSummary !== before.captionSummary;
  });

  const submit = useCallback(async () => {
    setSave({ status: "saving" });
    let response: Response;
    try {
      response = await fetch("/api/digest/copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digestId, stories: drafts }),
      });
    } catch {
      setSave({ status: "error", message: "Could not reach the server. Check your connection and try again." });
      return;
    }

    const body = (await response.json().catch(() => ({}))) as SaveResponse;
    if (!response.ok || !body.ok) {
      if (body.problems) setServerProblems(body.problems);
      setSave({ status: "error", message: body.message ?? "Something went wrong. Please try again." });
      return;
    }
    window.location.reload();
  }, [digestId, drafts]);

  return { drafts, update, reset, problems, changed, save, submit };
}
