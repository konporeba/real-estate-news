// Operator-facing wording for a digest's status and week — the redesign's single vocabulary, so the
// dashboard list, the "this week" card and the detail pages never drift into raw enum names like
// `ready_for_selection`. Pure and runtime-neutral: the Astro pages import it, and it is unit-tested.
import type { DigestStatus } from "@/types";

/**
 * How a status chip is drawn. `turn` is the only one using the signal colour: it marks a digest
 * waiting on the operator's own decision.
 */
export type StatusTone = "turn" | "progress" | "done" | "quiet" | "problem";

/** How each tone is drawn — shared by the Astro chip and the React one so the two never drift. */
export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  turn: "bg-signal font-semibold text-signal-foreground",
  progress: "border bg-muted font-medium text-foreground",
  done: "bg-primary font-medium text-primary-foreground",
  quiet: "border border-dashed border-input bg-card font-medium text-foreground",
  problem: "border border-destructive bg-destructive-tint font-semibold text-destructive",
};

/** The chip's own shape, around the tone. */
export const STATUS_CHIP_CLASSES = "inline-flex h-7 shrink-0 items-center rounded-full px-3 text-[13px]";

export const STATUS_PRESENTATION: Record<DigestStatus, { label: string; tone: StatusTone }> = {
  collecting: { label: "Collecting", tone: "progress" },
  ranking: { label: "Ranking", tone: "progress" },
  ready_for_selection: { label: "Your turn · Pick stories", tone: "turn" },
  generating: { label: "Writing copy", tone: "progress" },
  rendering: { label: "Designing slides", tone: "progress" },
  ready_for_approval: { label: "Your turn · Approve", tone: "turn" },
  approved: { label: "Approved · Scheduled", tone: "done" },
  rejected: { label: "Sent back", tone: "quiet" },
  published: { label: "Published", tone: "done" },
  skipped: { label: "Skipped · Missed deadline", tone: "quiet" },
  closed: { label: "Closed", tone: "quiet" },
  failed: { label: "Needs attention", tone: "problem" },
};

/**
 * Every status the operator has to act on — both human gates, plus the two dead ends only the
 * operator can resolve (a skipped week can still be published by hand; a failed one needs a look).
 * Wider than the old "Active only" filter, which stopped before the approval gate.
 */
export const NEEDS_OPERATOR_STATUSES: DigestStatus[] = [
  "ready_for_selection",
  "ready_for_approval",
  "skipped",
  "failed",
];

/** The week's run as the operator sees it; `operator` marks the two steps that wait on him. */
export const PIPELINE_STEPS = [
  { label: "Collect", operator: false },
  { label: "Rank", operator: false },
  { label: "You pick stories", operator: true },
  { label: "Write copy", operator: false },
  { label: "Design slides", operator: false },
  { label: "You approve", operator: true },
  { label: "Publish", operator: false },
] as const;

/**
 * Index into PIPELINE_STEPS of the step a digest is on; steps before it are done.
 * `PIPELINE_STEPS.length` means every step is done. Null for `failed`, which does not record
 * which stage it stopped at in the status alone, and for `closed`, which ended the run off the
 * pipeline — the timeline is not drawn for either.
 */
export function currentStepIndex(status: DigestStatus): number | null {
  switch (status) {
    case "collecting":
      return 0;
    case "ranking":
      return 1;
    case "ready_for_selection":
      return 2;
    case "generating":
      return 3;
    case "rendering":
      return 4;
    case "ready_for_approval":
    case "rejected":
    case "skipped":
      return 5;
    case "approved":
      return 6;
    case "published":
      return PIPELINE_STEPS.length;
    case "failed":
    case "closed":
      return null;
  }
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: "UTC" });
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

function parseDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * "12–18 October", or "28 September – 4 October" across a month boundary. Formatted in UTC because
 * the inputs are plain `YYYY-MM-DD` dates: in local time a negative offset would shift each a day.
 * Falls back to the raw strings for a malformed date rather than printing "Invalid Date".
 */
export function formatWeek(start: string, end: string): string {
  const from = parseDate(start);
  const to = parseDate(end);
  if (!from || !to) return `${start} – ${end}`;
  if (from.getUTCMonth() === to.getUTCMonth()) return `${DAY.format(from)}–${DAY_MONTH.format(to)}`;
  return `${DAY_MONTH.format(from)} – ${DAY_MONTH.format(to)}`;
}
