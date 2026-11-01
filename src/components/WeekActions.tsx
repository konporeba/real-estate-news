// The "⋯" button that manages one week: retry it, close it, or delete it. Opens a small dialog
// listing only the actions the week allows (availableActions), then the standard ConfirmDialog
// saying plainly what will happen. A dialog rather than a dropdown so it is never clipped by the
// list's rounded box and works the same on a phone.
//
// Used in the week list (which refetches on success) and on the dashboard's "this week" card and
// the week page (which reload, or return to the dashboard after a delete — the default).
import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useWeekAction, type WeekActionDone } from "@/components/hooks/useWeekAction";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";
import { formatWeek } from "@/lib/digest/presentation";
import { availableActions, type WeekAction } from "@/lib/digest/week-actions";
import type { WeekRow } from "@/lib/digest/week-list";
import { cn } from "@/lib/utils";

interface WeekActionsProps {
  week: Pick<WeekRow, "id" | "window_start" | "window_end" | "status" | "updated_at">;
  /** Called after a successful action. Without it the page reloads, or goes to the dashboard after a delete. */
  onDone?: (done: WeekActionDone) => void;
  /** "icon" for a list row; "button" for a page header. */
  variant?: "icon" | "button";
}

function reloadOrLeave(done: WeekActionDone): void {
  if (done.action === "delete") window.location.assign("/dashboard");
  else window.location.reload();
}

const CHOICES: Record<WeekAction, { label: string; detail: (status: WeekRow["status"]) => string }> = {
  retry: {
    label: "Retry",
    detail: (status) =>
      status === "rejected" ? "Write new copy for the same stories." : "Run it again from the step that failed.",
  },
  close: {
    label: "Close",
    detail: () => "End it without publishing. It stops asking for your attention.",
  },
  delete: {
    label: "Delete",
    detail: () => "Erase it and everything in it, for good.",
  },
};

function confirmCopy(
  action: WeekAction,
  status: WeekRow["status"],
  weekLabel: string,
): { title: string; confirmLabel: string; body: string[] } {
  switch (action) {
    case "retry":
      return status === "rejected"
        ? {
            title: `Write new copy for ${weekLabel}?`,
            confirmLabel: "Write new copy",
            body: [
              "Fresh copy is written for the same stories, then the slides are redrawn.",
              "It starts within 5 minutes, and you'll get an email when it's ready for your approval.",
            ],
          }
        : {
            title: `Retry ${weekLabel}?`,
            confirmLabel: "Retry",
            body: [
              "The week runs again from the step that failed, keeping everything finished before it.",
              "It starts within 5 minutes, and you'll get an email when it needs you.",
            ],
          };
    case "close":
      return {
        title: `Close ${weekLabel}?`,
        confirmLabel: "Close the week",
        body: [
          status === "approved"
            ? "It is approved and would be posted on Tuesday. Closing it cancels that — it will never be published."
            : "It will never be published.",
          "It leaves “Needs me” and the Monday reminder. You can still open it, or delete it later.",
        ],
      };
    case "delete":
      return {
        title: `Delete ${weekLabel}?`,
        confirmLabel: "Delete for good",
        body: [
          "This erases the week and everything in it: the shortlist, your picks, the copy and the slide images. It can't be undone.",
          ...(status === "published" || status === "approved"
            ? ["Anything already posted on Facebook or Instagram stays there."]
            : []),
          "If you picked stories that week, they stop being used as examples when ranking future weeks.",
        ],
      };
  }
}

export function WeekActions({ week, onDone = reloadOrLeave, variant = "icon" }: WeekActionsProps) {
  const [choosing, setChoosing] = useState(false);
  const chooseRef = useRef<HTMLDialogElement>(null);
  const action = useWeekAction(week.id, onDone);
  const weekLabel = `the week of ${formatWeek(week.window_start, week.window_end)}`;
  // Evaluated when the dialog opens, so a week that stopped running since the page loaded is
  // offered its actions (the server re-checks either way).
  const [actions, setActions] = useState<WeekAction[]>([]);

  useEffect(() => {
    const dialog = chooseRef.current;
    if (!dialog) return;
    if (choosing && !dialog.open) dialog.showModal();
    if (!choosing && dialog.open) dialog.close();
  }, [choosing]);

  const open = () => {
    setActions(availableActions(week, new Date()));
    setChoosing(true);
  };

  const pick = (chosen: WeekAction) => {
    setChoosing(false);
    action.ask(chosen);
  };

  const copy = action.confirming ? confirmCopy(action.confirming, week.status, weekLabel) : null;

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        aria-label={`Manage ${weekLabel}`}
        className={cn(
          variant === "icon"
            ? "text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl transition-colors"
            : SECONDARY_BUTTON,
        )}
      >
        {variant === "icon" ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        ) : (
          "Manage week"
        )}
      </button>

      <dialog
        ref={chooseRef}
        aria-labelledby={`manage-${week.id}`}
        onCancel={(event) => {
          event.preventDefault();
          setChoosing(false);
        }}
        className="bg-card text-foreground backdrop:bg-primary/55 m-auto max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-md rounded-[20px] p-7 shadow-2xl"
      >
        <h2 id={`manage-${week.id}`} className="text-[22px] leading-tight font-bold">
          Week of {formatWeek(week.window_start, week.window_end)}
        </h2>
        {actions.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-[15px] leading-relaxed">
            This week is being worked on right now. Its actions come back once this step finishes.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {actions.map((choice) => (
              <li key={choice}>
                <button
                  type="button"
                  onClick={() => {
                    pick(choice);
                  }}
                  className="hover:bg-muted flex w-full cursor-pointer flex-col items-start rounded-xl border px-4 py-3 text-left transition-colors"
                >
                  <span className="font-semibold">{CHOICES[choice].label}</span>
                  <span className="text-muted-foreground text-sm">{CHOICES[choice].detail(week.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => {
              setChoosing(false);
            }}
          >
            Back
          </button>
        </div>
      </dialog>

      <ConfirmDialog
        open={copy !== null}
        title={copy?.title ?? ""}
        confirmLabel={copy?.confirmLabel ?? ""}
        busy={action.state.status === "submitting"}
        onConfirm={() => {
          void action.confirm();
        }}
        onCancel={action.cancel}
      >
        <div className="text-muted-foreground space-y-2 text-[15px] leading-relaxed">
          {copy?.body.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        {action.state.status === "error" && (
          <p role="alert" className="text-destructive mt-3 text-sm font-semibold">
            {action.state.message}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
