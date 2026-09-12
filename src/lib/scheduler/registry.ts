// F-05: the single place naming which jobs exist and when they run. Data only, no
// worker-side action logic — that stays in src/worker/scheduled-run.ts, which is what
// keeps this module free of @/lib/collection or @/lib/llm imports. S-07 added
// "approval-reminder" below with zero changes to src/lib/scheduler/schedule.ts or the
// orchestration entrypoint's due-check loop — exactly the generality this file's original
// comment predicted; S-08 will add a third entry, "publish", the same way.
import type { WeeklySchedule } from "@/lib/scheduler/schedule";

export interface ScheduledJobDefinition {
  name: string;
  schedule: WeeklySchedule;
}

/** Sunday 17:00 Europe/Warsaw — the PRD's own reference point for the collection trigger. */
export const SCHEDULED_JOBS: readonly ScheduledJobDefinition[] = [
  { name: "collection", schedule: { dayOfWeek: 0, hour: 17, minute: 0 } },
  // S-07/FR-021: a full day before Tuesday 17:00's scheduled publish (S-08), so a Monday morning
  // reminder still leaves time to act. dayOfWeek 1 = Monday, the same 0=Sunday convention
  // WeeklySchedule documents.
  { name: "approval-reminder", schedule: { dayOfWeek: 1, hour: 9, minute: 0 } },
];
