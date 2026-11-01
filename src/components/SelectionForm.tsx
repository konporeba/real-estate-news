// The story selection gate's operator UI (S-04, FR-012, US-09) — the app's first hydrated island.
//
// It hydrates because the 2-4 rule needs to be answered as the operator clicks, and because
// confirming is irreversible: `ready_for_selection -> generating` has no way back in the state
// machine, so a review step stands between the checkboxes and the transition. Everything it
// enforces is re-enforced by the endpoint and again by confirm_selection(); this layer is the
// affordance, not the gate.
import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ShortlistCard } from "@/components/ShortlistCard";
import { useSelection } from "@/components/hooks/useSelection";
import { PRIMARY_BUTTON } from "@/components/ui/button-styles";
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

const LEGEND = "mb-2.5 text-[13px] font-semibold tracking-[0.08em] text-muted-foreground uppercase";

/** Tells the operator exactly what stands between him and the button, rather than just greying it out. */
function nextStepHint(pickCount: number, platformCount: number): string {
  if (pickCount < MIN_PICKS) {
    const missing = MIN_PICKS - pickCount;
    return `Pick ${String(missing)} more ${missing === 1 ? "story" : "stories"} to continue.`;
  }
  if (pickCount > MAX_PICKS) return `${String(MAX_PICKS)} stories at most. Remove ${String(pickCount - MAX_PICKS)}.`;
  if (platformCount === 0) return "Choose at least one place to post.";
  return "Ready. You'll review the finished post before it goes out.";
}

export function SelectionForm({ digestId, items }: SelectionFormProps) {
  const shortlistClusterIds = items.map((item) => item.clusterId);
  const selection = useSelection(digestId, shortlistClusterIds);
  const [reviewing, setReviewing] = useState(false);

  const { picked, format, platforms, canSubmit, submit } = selection;
  // In the operator's own picking order, which is the order the slots and the review list show.
  const pickedItems = picked.flatMap((id) => items.filter((item) => item.clusterId === id));
  const busy = submit.status === "submitting";
  // A stale shortlist means the page no longer matches the database — re-picking cannot fix it,
  // so the operator is pointed at a reload instead of being left to retry the same request.
  const stale = submit.status === "error" && submit.reason === "stale_shortlist";
  const slots = Array.from({ length: Math.max(MAX_PICKS, pickedItems.length) }, (_, i) => pickedItems.at(i));

  return (
    <div className="flex flex-wrap items-start gap-7">
      <ul aria-label="Shortlist" className="flex min-w-0 flex-[999_1_560px] flex-col gap-3">
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

      <aside
        aria-label="Your selection"
        className="bg-card flex min-w-0 flex-[1_1_340px] flex-col gap-5.5 rounded-[20px] border p-6 lg:sticky lg:top-6"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xl font-bold">Your picks</h2>
          <span className="font-mono text-[15px] font-medium">
            {picked.length} / {MAX_PICKS}
          </span>
        </div>

        <ol className="flex flex-col gap-2">
          {slots.map((item, i) => {
            const over = i >= MAX_PICKS;
            return (
              <li
                key={item?.clusterId ?? `empty-${String(i)}`}
                className={cn(
                  "flex min-h-11 items-baseline gap-3 rounded-xl px-3.5 py-3 text-sm leading-snug",
                  over
                    ? "border-destructive bg-destructive-tint text-destructive border"
                    : item
                      ? "border-signal bg-signal-tint border"
                      : "text-muted-foreground border border-dashed",
                )}
              >
                <span className="text-muted-foreground shrink-0 font-mono text-[13px]">{i + 1}</span>
                <span>
                  {item ? (item.polishTitle ?? item.originalTitle) : i < MIN_PICKS ? "Pick a story" : "Optional"}
                </span>
              </li>
            );
          })}
        </ol>

        <fieldset>
          <legend className={LEGEND}>Format</legend>
          <div className="bg-muted grid grid-cols-2 gap-1.5 rounded-xl border p-1">
            {SELECTION_FORMATS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={format === value}
                onClick={() => {
                  selection.setFormat(value);
                }}
                className={cn(
                  "min-h-10 cursor-pointer rounded-[9px] text-sm transition-colors",
                  format === value ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-card font-medium",
                )}
              >
                {FORMAT_LABELS[value]}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className={LEGEND}>Post to</legend>
          <div className="flex flex-wrap gap-2">
            {SELECTION_PLATFORMS.map((value) => {
              const on = platforms.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    selection.togglePlatform(value);
                  }}
                  className={cn(
                    "min-h-11 cursor-pointer rounded-full border px-4 text-sm font-medium transition-colors",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-muted",
                  )}
                >
                  {PLATFORM_LABELS[value]}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2.5 border-t pt-4">
          <p
            role="status"
            className={cn(
              "text-sm leading-snug",
              canSubmit ? "text-signal-strong font-semibold" : "text-muted-foreground",
            )}
          >
            {nextStepHint(picked.length, platforms.length)}
          </p>
          {submit.status === "error" && (
            <div
              role="alert"
              className="border-destructive bg-destructive-tint text-destructive rounded-xl border p-3 text-sm"
            >
              <p>{submit.message}</p>
              {stale && (
                <button
                  type="button"
                  className="mt-2 cursor-pointer font-semibold underline hover:no-underline"
                  onClick={() => {
                    window.location.reload();
                  }}
                >
                  Reload the shortlist
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={!canSubmit || busy}
            onClick={() => {
              setReviewing(true);
            }}
          >
            Review and confirm
          </button>
        </div>
      </aside>

      <ConfirmDialog
        open={reviewing}
        title={`Start writing these ${String(pickedItems.length)} stories?`}
        busy={busy}
        onCancel={() => {
          setReviewing(false);
        }}
        cancelLabel="Change picks"
        confirmLabel={busy ? "Confirming…" : "Confirm and start writing"}
        onConfirm={() => {
          // On success the page reloads and this never runs; on failure the dialog must
          // close, or the error it produced sits hidden behind this overlay.
          void selection.confirm().then(() => {
            setReviewing(false);
          });
        }}
      >
        <p className="text-muted-foreground text-[15px] leading-relaxed">
          {FORMAT_LABELS[format]} for {platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}. Picks are locked once
          writing starts. You still approve the finished post before anything is published.
        </p>
        <ol className="mt-4 flex flex-col gap-2">
          {pickedItems.map((item) => (
            <li key={item.clusterId} className="flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-snug">
              <span className="text-muted-foreground font-mono">#{item.rank}</span>
              <span className="font-medium">{item.polishTitle ?? item.originalTitle}</span>
            </li>
          ))}
        </ol>
      </ConfirmDialog>
    </div>
  );
}
