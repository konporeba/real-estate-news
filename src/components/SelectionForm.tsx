// The story selection gate's operator UI (S-04, FR-012, US-09) — the app's first hydrated island.
//
// It hydrates because the 2-4 rule needs to be answered as the operator clicks, and because
// confirming is irreversible: `ready_for_selection -> generating` has no way back in the state
// machine, so a review step stands between the checkboxes and the transition. Everything it
// enforces is re-enforced by the endpoint and again by confirm_selection(); this layer is the
// affordance, not the gate.
import { useState } from "react";

import { ShortlistCard } from "@/components/ShortlistCard";
import { useSelection } from "@/components/hooks/useSelection";
import {
  FORMAT_LABELS,
  MAX_PICKS,
  MIN_PICKS,
  PLATFORM_LABELS,
  SELECTION_FORMATS,
  SELECTION_PLATFORMS,
} from "@/lib/selection/rules";
import { cn } from "@/lib/utils";
import type { ShortlistItem } from "@/types";

export interface SelectionFormProps {
  digestId: string;
  items: ShortlistItem[];
}

const PRIMARY_BUTTON =
  "rounded-lg bg-purple-500 px-4 py-2 font-semibold text-white transition-colors hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-purple-500";
const SECONDARY_BUTTON =
  "rounded-lg border border-white/20 bg-white/5 px-4 py-2 font-semibold text-blue-100/80 transition-colors hover:bg-white/10";
const CHOICE_BASE = "rounded-lg border px-3 py-2 text-sm transition-colors";
const CHOICE_ON = "border-purple-400/50 bg-purple-500/20 text-white";
const CHOICE_OFF = "border-white/15 bg-white/5 text-blue-100/70 hover:bg-white/10";

export function SelectionForm({ digestId, items }: SelectionFormProps) {
  const shortlistClusterIds = items.map((item) => item.clusterId);
  const selection = useSelection(digestId, shortlistClusterIds);
  const [reviewing, setReviewing] = useState(false);

  const { picked, format, platforms, canSubmit, submit } = selection;
  const pickedItems = items.filter((item) => picked.includes(item.clusterId));
  const busy = submit.status === "submitting";
  // A stale shortlist means the page no longer matches the database — re-picking cannot fix it,
  // so the operator is pointed at a reload instead of being left to retry the same request.
  const stale = submit.status === "error" && submit.reason === "stale_shortlist";

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 rounded-xl border border-white/10 bg-slate-900/80 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">
              {picked.length} of {MIN_PICKS}–{MAX_PICKS} stories selected
            </p>
            <p className="text-xs text-blue-100/60">Confirming starts generation and cannot be undone.</p>
          </div>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={!canSubmit || busy}
            onClick={() => {
              setReviewing(true);
            }}
          >
            Review selection
          </button>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <fieldset>
            <legend className="text-xs tracking-wide text-blue-100/60 uppercase">Format</legend>
            <div className="mt-2 flex gap-2">
              {SELECTION_FORMATS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={format === value}
                  onClick={() => {
                    selection.setFormat(value);
                  }}
                  className={cn(CHOICE_BASE, format === value ? CHOICE_ON : CHOICE_OFF)}
                >
                  {FORMAT_LABELS[value]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-xs tracking-wide text-blue-100/60 uppercase">Platforms</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {SELECTION_PLATFORMS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={platforms.includes(value)}
                  onClick={() => {
                    selection.togglePlatform(value);
                  }}
                  className={cn(CHOICE_BASE, platforms.includes(value) ? CHOICE_ON : CHOICE_OFF)}
                >
                  {PLATFORM_LABELS[value]}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        {submit.status === "error" && (
          <div className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
            <p>{submit.message}</p>
            {stale && (
              <button
                type="button"
                className="mt-2 underline hover:no-underline"
                onClick={() => {
                  window.location.reload();
                }}
              >
                Reload the shortlist
              </button>
            )}
          </div>
        )}
      </div>

      <ul className="space-y-3">
        {items.map((item) => (
          <ShortlistCard
            key={item.clusterId}
            item={item}
            selectable
            selected={selection.isPicked(item.clusterId)}
            onToggle={selection.togglePick}
          />
        ))}
      </ul>

      {reviewing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm selection"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-white/15 bg-slate-900 p-6 text-white shadow-xl">
            <h2 className="text-lg font-semibold">Confirm this week’s selection</h2>
            <p className="mt-1 text-sm text-blue-100/70">
              These {pickedItems.length} stories go to generation as {FORMAT_LABELS[format].toLowerCase()} content for{" "}
              {platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}. This cannot be undone.
            </p>

            <ol className="mt-4 space-y-2">
              {pickedItems.map((item) => (
                <li key={item.clusterId} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm">
                  <span className="text-blue-100/50">#{item.rank}</span>{" "}
                  <span className="font-medium">{item.polishTitle ?? item.originalTitle}</span>
                </li>
              ))}
            </ol>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={busy}
                onClick={() => {
                  setReviewing(false);
                }}
              >
                Back
              </button>
              <button
                type="button"
                className={PRIMARY_BUTTON}
                disabled={busy}
                onClick={() => {
                  // On success the page reloads and this never runs; on failure the dialog must
                  // close, or the error banner it produced sits hidden behind this overlay.
                  void selection.confirm().then(() => {
                    setReviewing(false);
                  });
                }}
              >
                {busy ? "Confirming…" : "Confirm and generate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
