import { describe, expect, it } from "vitest";

import { collectionWindowFrom, currentWeekWindow, startOfDayInZone, zonedDateString } from "@/lib/collection/window";

describe("startOfDayInZone", () => {
  it("resolves local midnight in winter (UTC+1)", () => {
    expect(startOfDayInZone("2026-01-15").toISOString()).toBe("2026-01-14T23:00:00.000Z");
  });

  it("resolves local midnight in summer (UTC+2)", () => {
    expect(startOfDayInZone("2026-07-15").toISOString()).toBe("2026-07-14T22:00:00.000Z");
  });

  // The whole reason this is computed from a named zone rather than a stored offset.
  it("stays correct across the spring-forward date", () => {
    // Poland springs forward on the last Sunday of March (2026-03-29, 02:00 -> 03:00).
    expect(startOfDayInZone("2026-03-28").toISOString()).toBe("2026-03-27T23:00:00.000Z");
    expect(startOfDayInZone("2026-03-29").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(startOfDayInZone("2026-03-30").toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("stays correct across the autumn fall-back date", () => {
    // Last Sunday of October (2026-10-25, 03:00 -> 02:00).
    expect(startOfDayInZone("2026-10-24").toISOString()).toBe("2026-10-23T22:00:00.000Z");
    expect(startOfDayInZone("2026-10-25").toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(startOfDayInZone("2026-10-26").toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("rejects a malformed date", () => {
    expect(() => startOfDayInZone("not-a-date")).toThrow(/invalid date/);
  });
});

describe("zonedDateString", () => {
  it("reports the local date, not the UTC one, near midnight", () => {
    // 22:30 UTC in July is already the next day in Warsaw (UTC+2).
    expect(zonedDateString(new Date("2026-07-14T22:30:00Z"))).toBe("2026-07-15");
    expect(zonedDateString(new Date("2026-07-14T21:30:00Z"))).toBe("2026-07-14");
  });
});

describe("currentWeekWindow", () => {
  it("returns the Monday–Sunday pair containing a midweek instant", () => {
    // 2026-07-24 is a Friday.
    expect(currentWeekWindow(new Date("2026-07-24T12:00:00Z"))).toEqual({
      start: "2026-07-20",
      end: "2026-07-26",
    });
  });

  it("treats Monday as the first day, not the last", () => {
    expect(currentWeekWindow(new Date("2026-07-20T08:00:00Z"))).toEqual({
      start: "2026-07-20",
      end: "2026-07-26",
    });
  });

  it("keeps Sunday in the week that is closing, not the next one", () => {
    expect(currentWeekWindow(new Date("2026-07-26T18:00:00Z"))).toEqual({
      start: "2026-07-20",
      end: "2026-07-26",
    });
  });

  it("uses the local date when UTC and Warsaw disagree", () => {
    // 22:30 UTC Sunday is Monday 00:30 in Warsaw -> the NEW week.
    expect(currentWeekWindow(new Date("2026-07-26T22:30:00Z"))).toEqual({
      start: "2026-07-27",
      end: "2026-08-02",
    });
  });

  it("always spans exactly seven days", () => {
    for (let day = 20; day <= 26; day++) {
      const window = currentWeekWindow(new Date(`2026-07-${day}T12:00:00Z`));
      const span = (Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) / 86_400_000;
      expect(span).toBe(6);
    }
  });
});

describe("collectionWindowFrom", () => {
  const now = new Date("2026-07-26T17:00:00Z");

  it("uses the previous digest's checkpoint as the lower bound", () => {
    const window = collectionWindowFrom("2026-07-19T17:04:31.000Z", "2026-07-20", now);

    expect(window.from.toISOString()).toBe("2026-07-19T17:04:31.000Z");
    expect(window.to).toBe(now);
  });

  it("falls back to local midnight of window_start when there is no previous digest", () => {
    const window = collectionWindowFrom(null, "2026-07-20", now);

    // 00:00 Warsaw on 2026-07-20, i.e. 22:00 UTC the day before.
    expect(window.from.toISOString()).toBe("2026-07-19T22:00:00.000Z");
  });

  it("uses the run time as the upper bound", () => {
    expect(collectionWindowFrom(null, "2026-07-20", now).to).toBe(now);
  });

  // Tiling: consecutive runs must leave no gap and no overlap.
  it("starts exactly where the previous run stopped", () => {
    const previousRunEnded = new Date("2026-07-19T17:04:31.000Z");
    const thisRun = collectionWindowFrom(previousRunEnded.toISOString(), "2026-07-20", now);

    expect(thisRun.from.getTime()).toBe(previousRunEnded.getTime());
  });

  // This is roadmap OQ#7: a story published late Sunday is after `to`, so the NEXT run
  // collects it. Nothing is dropped and there is no declared cutoff to maintain.
  it("leaves a late-Sunday story to the following run rather than dropping it", () => {
    const lateSundayStory = new Date("2026-07-26T21:50:00Z");
    const thisRun = collectionWindowFrom(null, "2026-07-20", now);
    expect(lateSundayStory.getTime()).toBeGreaterThan(thisRun.to.getTime());

    const nextRun = collectionWindowFrom(now.toISOString(), "2026-07-27", new Date("2026-08-02T17:00:00Z"));
    expect(lateSundayStory.getTime()).toBeGreaterThanOrEqual(nextRun.from.getTime());
    expect(lateSundayStory.getTime()).toBeLessThan(nextRun.to.getTime());
  });
});
