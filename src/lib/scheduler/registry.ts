// F-05: the single place naming which jobs exist and when they run. Data only, no
// worker-side action logic — that stays in src/worker/scheduled-run.ts, which is what
// keeps this module free of @/lib/collection or @/lib/llm imports. S-08 adds a "publish"
// entry here later with zero changes to src/lib/scheduler/schedule.ts or the
// orchestration entrypoint's due-check loop.
import type { WeeklySchedule } from "@/lib/scheduler/schedule";

export interface ScheduledJobDefinition {
  name: string;
  schedule: WeeklySchedule;
}

/** Sunday 17:00 Europe/Warsaw — the PRD's own reference point for the collection trigger. */
export const SCHEDULED_JOBS: readonly ScheduledJobDefinition[] = [
  { name: "collection", schedule: { dayOfWeek: 0, hour: 17, minute: 0 } },
];
