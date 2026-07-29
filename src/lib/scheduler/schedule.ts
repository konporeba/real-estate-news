// F-05: DST-correct weekly schedule math, no date library — the same technique as
// src/lib/collection/window.ts (Intl.DateTimeFormat with a named zone, plus a two-pass
// offset-guess-then-refine resolution for the DST-transition date itself). This module is
// self-contained rather than importing window.ts's helpers: scheduler is a general
// primitive collection plugs a job into, not the other way around.
//
// The due-check is "what is the most recent instant, at or before now, that a job's
// weekly schedule specifies" — not "did 7 days pass since last fire", which would drift
// and wouldn't collapse a multi-week outage to a single catch-up fire. isJobDue only ever
// compares against this single most-recent instant, so any length of outage collapses to
// exactly one due=true.
export const SCHEDULER_TIMEZONE = "Europe/Warsaw";

const zonedFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULER_TIMEZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant as seen in SCHEDULER_TIMEZONE. */
function zonedParts(instant: Date): ZonedParts {
  const parts = zonedFormatter.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`Intl did not return a "${type}" part`);
    // "24" is how hour12:false renders midnight in some ICU versions.
    return Number(found.value) % (type === "hour" ? 24 : Number.MAX_SAFE_INTEGER);
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** The zone's UTC offset (ms) at a given instant — positive east of Greenwich. */
function offsetAt(instant: Date): number {
  const p = zonedParts(instant);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/** `YYYY-MM-DD` as the date reads in the zone at that instant. */
function zonedDateString(instant: Date): string {
  const { year, month, day } = zonedParts(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Add whole calendar days to a `YYYY-MM-DD` string. DST-free: pure date arithmetic. */
function addDays(date: string, days: number): string {
  const shifted = new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The instant at which `hour:minute` occurs, in the zone, on the given calendar date.
 *
 * Resolved in two passes, mirroring `window.ts`'s `startOfDayInZone`: guess using the
 * offset at UTC midnight, then re-check the offset at the candidate instant. The second
 * pass is what makes a DST-transition date correct, since the offset before and after the
 * change differ.
 */
function zonedInstant(date: string, hour: number, minute: number): Date {
  const guess = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  if (Number.isNaN(guess.getTime())) throw new Error(`invalid date: ${date}`);

  const firstPass = new Date(guess.getTime() - offsetAt(guess));
  const secondOffset = offsetAt(firstPass);
  return new Date(guess.getTime() - secondOffset);
}

/** A job that fires once a week, at a fixed zoned wall-clock time. */
export interface WeeklySchedule {
  /** 0 = Sunday, matching `Date#getUTCDay()` applied to zoned date parts — same convention as `window.ts`'s `currentWeekWindow`. */
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  hour: number;
  minute: number;
}

/**
 * The most recent instant, at or before `now`, that `schedule` specifies.
 *
 * Finds the most recent zoned calendar date whose day-of-week matches the schedule, then
 * steps back a further 7 days if that date's scheduled time is still in the future
 * relative to `now` (the scheduled day has arrived this week, but its hour hasn't yet).
 */
export function mostRecentScheduledInstant(schedule: WeeklySchedule, now: Date): Date {
  const today = zonedDateString(now);
  // Pure calendar-date arithmetic (parsing "YYYY-MM-DD" as UTC midnight) preserves
  // day-of-week regardless of zone, same trick `window.ts`'s `currentWeekWindow` uses.
  const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const daysSinceScheduledDow = (todayDow - schedule.dayOfWeek + 7) % 7;
  const candidateDate = addDays(today, -daysSinceScheduledDow);
  const candidateInstant = zonedInstant(candidateDate, schedule.hour, schedule.minute);

  if (candidateInstant.getTime() <= now.getTime()) return candidateInstant;
  return zonedInstant(addDays(candidateDate, -7), schedule.hour, schedule.minute);
}

/**
 * Whether `schedule` is due: `lastFiredAt` is unset, or older than the most recent
 * scheduled instant. Comparing only against the single most-recent instant — never
 * enumerating every individually-missed week — is what collapses any length of outage
 * into exactly one catch-up fire.
 */
export function isJobDue(schedule: WeeklySchedule, lastFiredAt: Date | null, now: Date): boolean {
  const due = mostRecentScheduledInstant(schedule, now);
  return lastFiredAt === null || lastFiredAt.getTime() < due.getTime();
}
