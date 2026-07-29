// Unit tests for the DST-correct weekly schedule math. Pure functions, `now` passed
// explicitly per test — matching src/lib/collection/window.test.ts's convention of
// injecting `now`/`instant` directly rather than global fake timers.
import { describe, expect, it } from "vitest";

import { isJobDue, mostRecentScheduledInstant, type WeeklySchedule } from "@/lib/scheduler/schedule";

// Sunday 17:00 Europe/Warsaw — the same schedule the real job registry uses.
const SUNDAY_17_00: WeeklySchedule = { dayOfWeek: 0, hour: 17, minute: 0 };

describe("mostRecentScheduledInstant", () => {
  it("resolves the spring-forward Sunday's 17:00 correctly (CET -> CEST, 2026-03-29)", () => {
    // Warsaw/Madrid both switch to CEST (UTC+2) at 2026-03-29 01:00 UTC. 17:00 local on
    // the transition day is therefore 15:00 UTC, not the pre-transition 16:00 UTC a naive
    // fixed-offset calculation would produce.
    const now = new Date("2026-03-29T18:00:00Z"); // well after the local 17:00 has passed
    const due = mostRecentScheduledInstant(SUNDAY_17_00, now);
    expect(due.toISOString()).toBe("2026-03-29T15:00:00.000Z");
  });

  it("resolves the fall-back Sunday's 17:00 correctly (CEST -> CET, 2026-10-25)", () => {
    // Switches back to CET (UTC+1) at 2026-10-25 01:00 UTC. 17:00 local is therefore
    // 16:00 UTC, not the pre-transition 15:00 UTC.
    const now = new Date("2026-10-25T19:00:00Z");
    const due = mostRecentScheduledInstant(SUNDAY_17_00, now);
    expect(due.toISOString()).toBe("2026-10-25T16:00:00.000Z");
  });

  it("steps back a week when today is the scheduled day but the hour hasn't arrived yet", () => {
    // 2026-03-29T10:00:00Z is 12:00 local (CEST, +2) — same Sunday, but before 17:00.
    const now = new Date("2026-03-29T10:00:00Z");
    const due = mostRecentScheduledInstant(SUNDAY_17_00, now);
    // The prior Sunday (2026-03-22) is still pre-transition, CET (+1): 17:00 local = 16:00 UTC.
    expect(due.toISOString()).toBe("2026-03-22T16:00:00.000Z");
  });

  it("resolves a mid-week now to the most recent Sunday", () => {
    // 2026-07-29 is a Wednesday (CEST, +2 year-round in July).
    const now = new Date("2026-07-29T12:00:00Z");
    const due = mostRecentScheduledInstant(SUNDAY_17_00, now);
    expect(due.toISOString()).toBe("2026-07-26T15:00:00.000Z");
  });
});

describe("isJobDue", () => {
  const now = new Date("2026-07-29T12:00:00Z"); // Wednesday; most recent Sunday 17:00 was 2026-07-26T15:00:00Z

  it("is due when the job has never fired", () => {
    expect(isJobDue(SUNDAY_17_00, null, now)).toBe(true);
  });

  it("is not due when it already fired at (or after) the most recent scheduled instant", () => {
    const justFired = new Date("2026-07-26T15:00:00.000Z");
    expect(isJobDue(SUNDAY_17_00, justFired, now)).toBe(false);
  });

  it("is due when the last fire predates the most recent scheduled instant", () => {
    const firedLastWeek = new Date("2026-07-19T15:00:00.000Z");
    expect(isJobDue(SUNDAY_17_00, firedLastWeek, now)).toBe(true);
  });

  it("collapses a multi-week outage to a single due=true, not a count of missed weeks", () => {
    // Three weeks of silence still resolve to exactly one comparison against the single
    // most recent scheduled instant — there is no per-missed-week enumeration to collapse.
    const firedThreeWeeksAgo = new Date("2026-07-05T15:00:00.000Z");
    expect(isJobDue(SUNDAY_17_00, firedThreeWeeksAgo, now)).toBe(true);
    expect(mostRecentScheduledInstant(SUNDAY_17_00, now).toISOString()).toBe("2026-07-26T15:00:00.000Z");
  });
});
