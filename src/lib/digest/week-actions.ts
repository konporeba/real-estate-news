// What the operator can do to a week from the dashboard — retry it, close it, delete it — and where
// a retry sends it. Pure and runtime-neutral: the week list and week page use it to decide which
// actions to offer, and the action endpoint re-checks it against the row it just read, so a stale
// page can never do what the week no longer allows. The database's transition guard is the final
// word on any status change.
import { z } from "zod";

import { canTransition } from "@/lib/digest/state-machine";
import type { DigestStatus } from "@/types";

export const WEEK_ACTIONS = ["retry", "close", "delete"] as const;
export type WeekAction = (typeof WEEK_ACTIONS)[number];

/** The action endpoint's body. */
export const weekActionRequestSchema = z.object({
  digestId: z.uuid(),
  action: z.enum(WEEK_ACTIONS),
});

/** Statuses a worker moves a week out of on its own. */
export const WORKING_STATUSES: readonly DigestStatus[] = ["collecting", "ranking", "generating", "rendering"];

/**
 * How long a week may sit in a working status before it counts as a dead run rather than one in
 * progress. Matches the scheduler's stale-claim window (3 hours): no stage legitimately runs longer,
 * and the July week stuck in `ranking` since a crash must still be closable.
 */
export const RUNNING_WINDOW_MS = 3 * 60 * 60 * 1000;

export interface WeekFacts {
  status: DigestStatus;
  updated_at: string;
}

/** A worker may be writing to this week right now: touching it would race the run. */
export function isRunningNow(week: WeekFacts, now: Date): boolean {
  if (!WORKING_STATUSES.includes(week.status)) return false;
  return now.getTime() - Date.parse(week.updated_at) < RUNNING_WINDOW_MS;
}

/** The actions to offer, in menu order. Empty while the week is running. */
export function availableActions(week: WeekFacts, now: Date): WeekAction[] {
  if (isRunningNow(week, now)) return [];
  const actions: WeekAction[] = [];
  if (week.status === "failed" || week.status === "rejected") actions.push("retry");
  if (canTransition(week.status, "closed")) actions.push("close");
  actions.push("delete");
  return actions;
}

export interface RetryFacts {
  status: DigestStatus;
  generation_completed_at: string | null;
  /** The operator confirmed story picks for this week. */
  hasSelection: boolean;
  /** When the operator sent the post back for a rewrite, if they did. */
  rejectedAt: string | null;
}

/**
 * Where a retry restarts the week: the cheapest stage that still has what it needs.
 *
 * A sent-back week gets fresh copy on the same picks. A failed week restarts at the slides if it
 * has finished copy the operator has not rejected, at the copy if picks were confirmed, and
 * otherwise from collection — the three recovery edges FR-018 already allows.
 *
 * "Not rejected" matters because a failed rewrite deliberately keeps the previous copy (see
 * clearExistingCopy in generate.ts) and its `generation_completed_at`: without the check, a rewrite
 * that failed would "retry" by redrawing the slides from the copy the operator sent back.
 */
export function retryTarget(week: RetryFacts): DigestStatus | null {
  if (week.status === "rejected") return "generating";
  if (week.status !== "failed") return null;
  const copyIsCurrent =
    week.generation_completed_at !== null &&
    (week.rejectedAt === null || Date.parse(week.generation_completed_at) > Date.parse(week.rejectedAt));
  if (copyIsCurrent) return "rendering";
  if (week.hasSelection) return "generating";
  return "collecting";
}
