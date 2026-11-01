// The dashboard's "Previous weeks" list with its filters. Filter buttons switch the list in place
// (useWeekList fetches the page and updates the URL) instead of reloading the whole dashboard. Each
// button and "Show older weeks" keep a real href, so a middle-click opens a new tab and the list
// still works if JavaScript never loads.
import { useCallback, useState, type MouseEvent } from "react";

import { StatusBadge } from "@/components/StatusBadge";
import { WeekActions } from "@/components/WeekActions";
import type { WeekActionDone } from "@/components/hooks/useWeekAction";
import { useWeekList, type WeekListInitial } from "@/components/hooks/useWeekList";
import { formatWeek } from "@/lib/digest/presentation";
import { WEEK_VIEWS, weekRowNote, weekViewHref, type WeekView } from "@/lib/digest/week-list";
import { cn } from "@/lib/utils";

interface WeekListProps extends WeekListInitial {
  /** "Previous weeks" when a "this week" card sits above the list, else "All weeks". */
  title: string;
}

/** A plain left click — anything else (new tab, new window) is left to the browser. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function emptyMessage(view: WeekView, hasCurrent: boolean): string {
  if (view === "needs") return "Nothing needs you right now.";
  if (view === "published") return "Nothing has been published yet.";
  return hasCurrent ? "No earlier weeks yet." : "No digests yet. The first one is collected on Sunday at 17:00.";
}

const DONE_MESSAGE: Record<WeekActionDone["action"], string> = {
  retry: "Retry started. It runs within 5 minutes.",
  close: "Week closed. It won't be published.",
  delete: "Week deleted.",
};

export function WeekList({ title, ...initial }: WeekListProps) {
  const list = useWeekList(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const { refresh } = list;

  // Refetch rather than patch the row: a closed week leaves "Needs me", a retried one changes
  // chip, and the server's answer for the current filter is the one that is right.
  const onDone = useCallback(
    (done: WeekActionDone) => {
      setNotice(done.warning ? `${DONE_MESSAGE[done.action]} ${done.warning}` : DONE_MESSAGE[done.action]);
      refresh();
    },
    [refresh],
  );

  const olderHref = list.nextBefore
    ? `/dashboard?before=${list.nextBefore}${list.view === "all" ? "" : `&view=${list.view}`}`
    : null;

  return (
    <section aria-labelledby="archive-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="archive-title" className="text-[22px] font-bold tracking-tight">
          {title}
        </h2>
        <nav aria-label="Filter weeks" className="bg-card inline-flex flex-wrap gap-1 rounded-xl border p-1">
          {WEEK_VIEWS.map((v) => (
            <a
              key={v.id}
              href={weekViewHref(v.id)}
              aria-current={v.id === list.view ? "page" : undefined}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                if (v.id !== list.view || list.error) list.selectView(v.id);
              }}
              className={cn(
                "inline-flex min-h-9 items-center rounded-lg px-3.5 text-sm no-underline transition-colors",
                v.id === list.view
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "text-foreground hover:bg-muted font-medium",
              )}
            >
              {v.label}
            </a>
          ))}
        </nav>
      </div>

      {notice && (
        <p role="status" className="text-muted-foreground text-[15px]">
          {notice}
        </p>
      )}

      {list.error && (
        <div
          role="alert"
          className="border-destructive bg-destructive-tint text-destructive rounded-2xl border p-5 text-[15px]"
        >
          {list.error} Try the filter again.
        </div>
      )}

      <div aria-busy={list.loading} className={cn("transition-opacity", list.loading && "opacity-50")}>
        {list.weeks.length === 0 ? (
          !list.loading && (
            <div className="bg-card text-foreground rounded-2xl border p-5 text-[15px] leading-relaxed">
              {emptyMessage(list.view, initial.excludeId !== null)}
            </div>
          )
        ) : (
          <ul className="bg-card overflow-hidden rounded-2xl border">
            {list.weeks.map((week) => {
              const note = weekRowNote(week);
              return (
                <li key={week.id} className="flex items-center border-b pr-2 last:border-b-0 sm:pr-3">
                  <a
                    href={`/dashboard/${week.id}`}
                    className="text-foreground hover:bg-muted flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2 py-4 pr-3 pl-5 no-underline transition-colors sm:pl-6"
                  >
                    <span className="min-w-0 flex-[1_1_220px]">
                      <span className="block text-base font-semibold">
                        {formatWeek(week.window_start, week.window_end)}
                      </span>
                      {note && (
                        <span
                          className={cn(
                            "line-clamp-1 text-[13px]",
                            week.status === "failed" ? "text-destructive" : "text-muted-foreground",
                          )}
                        >
                          {note}
                        </span>
                      )}
                    </span>
                    <StatusBadge status={week.status} />
                    <span className="text-signal-strong text-sm font-semibold" aria-hidden="true">
                      Open →
                    </span>
                  </a>
                  <WeekActions week={week} onDone={onDone} />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {olderHref && !list.loading && (
        <div className="text-center">
          <a
            href={olderHref}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              list.loadOlder();
            }}
            aria-disabled={list.loadingOlder}
            className="inline-flex min-h-11 items-center px-4 text-sm font-semibold no-underline"
          >
            {list.loadingOlder ? "Loading…" : "Show older weeks"}
          </a>
        </div>
      )}
    </section>
  );
}
