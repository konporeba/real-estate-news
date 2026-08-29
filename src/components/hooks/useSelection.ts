// Selection-gate state for the SelectionForm island (S-04, FR-012).
//
// Holds nothing the server doesn't re-check: validity comes from @/lib/selection/rules, the same
// module the confirm endpoint validates with, so a submit this hook enables is one the database
// will accept. Extracted per CLAUDE.md's convention that hooks live in src/components/hooks/,
// and kept as a .ts file so the logic stays outside the .tsx that Vitest cannot collect.
import { useCallback, useState } from "react";

import { isSubmittable } from "@/lib/selection/rules";
import type { SelectionErrorReason, SelectionFormat, SelectionPlatform } from "@/types";

/** `network` covers a fetch that never produced a typed body (offline, 502 from a proxy). */
export type SubmitFailureReason = SelectionErrorReason | "network";

export type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; reason: SubmitFailureReason; message: string };

interface ConfirmResponse {
  ok?: boolean;
  reason?: SelectionErrorReason;
  message?: string;
}

export interface UseSelection {
  picked: string[];
  togglePick: (clusterId: string) => void;
  isPicked: (clusterId: string) => boolean;
  format: SelectionFormat;
  setFormat: (format: SelectionFormat) => void;
  platforms: SelectionPlatform[];
  togglePlatform: (platform: SelectionPlatform) => void;
  canSubmit: boolean;
  submit: SubmitState;
  confirm: () => Promise<void>;
}

export function useSelection(digestId: string, shortlistClusterIds: string[]): UseSelection {
  // Arrays rather than Sets: the order is the operator's own selection order, which the review
  // step lists back to him.
  const [picked, setPicked] = useState<string[]>([]);
  const [format, setFormat] = useState<SelectionFormat>("single_post");
  const [platforms, setPlatforms] = useState<SelectionPlatform[]>([]);
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });

  // Picking a fifth story is allowed and simply disables submit, rather than making the
  // checkbox inert: an operator swapping his mind about which four should not have to guess
  // why a box refuses to tick.
  const togglePick = useCallback((clusterId: string) => {
    setPicked((current) =>
      current.includes(clusterId) ? current.filter((id) => id !== clusterId) : [...current, clusterId],
    );
  }, []);

  const togglePlatform = useCallback((platform: SelectionPlatform) => {
    setPlatforms((current) =>
      current.includes(platform) ? current.filter((p) => p !== platform) : [...current, platform],
    );
  }, []);

  const isPicked = useCallback((clusterId: string) => picked.includes(clusterId), [picked]);

  const canSubmit = isSubmittable(picked.length, platforms.length);

  const confirm = useCallback(async () => {
    setSubmit({ status: "submitting" });

    let response: Response;
    try {
      response = await fetch("/api/selection/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          digestId,
          shortlistClusterIds,
          pickedClusterIds: picked,
          format,
          platforms,
        }),
      });
    } catch {
      setSubmit({ status: "error", reason: "network", message: "Could not reach the server." });
      return;
    }

    if (response.ok) {
      // The server owns what a confirmed digest looks like, so re-render from it rather than
      // reproducing the post-confirm view in client state.
      window.location.reload();
      return;
    }

    const body = (await response.json().catch(() => null)) as ConfirmResponse | null;
    setSubmit({
      status: "error",
      reason: body?.reason ?? "network",
      message: body?.message ?? `The request failed (${String(response.status)}).`,
    });
  }, [digestId, shortlistClusterIds, picked, format, platforms]);

  return {
    picked,
    togglePick,
    isPicked,
    format,
    setFormat,
    platforms,
    togglePlatform,
    canSubmit,
    submit,
    confirm,
  };
}
