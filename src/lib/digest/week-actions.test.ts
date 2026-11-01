import { describe, expect, it } from "vitest";

import { Constants } from "@/db/database.types";
import { availableActions, isRunningNow, retryTarget, RUNNING_WINDOW_MS } from "@/lib/digest/week-actions";

const NOW = new Date("2026-11-01T12:00:00Z");
const JUST_NOW = new Date(NOW.getTime() - 60_000).toISOString();
const LONG_AGO = new Date(NOW.getTime() - RUNNING_WINDOW_MS - 60_000).toISOString();

describe("availableActions", () => {
  it("offers nothing while a worker may be writing to the week", () => {
    for (const status of ["collecting", "ranking", "generating", "rendering"] as const) {
      expect(availableActions({ status, updated_at: JUST_NOW }, NOW)).toEqual([]);
    }
  });

  // The 2026-07-20 week sat in `ranking` for months after a crash: it must be clearable.
  it("treats a working week untouched for longer than the window as a dead run", () => {
    expect(isRunningNow({ status: "ranking", updated_at: LONG_AGO }, NOW)).toBe(false);
    expect(availableActions({ status: "ranking", updated_at: LONG_AGO }, NOW)).toEqual(["close", "delete"]);
  });

  it("offers retry only for a failed or sent-back week", () => {
    expect(availableActions({ status: "failed", updated_at: JUST_NOW }, NOW)).toEqual(["retry", "close", "delete"]);
    expect(availableActions({ status: "rejected", updated_at: JUST_NOW }, NOW)).toEqual(["retry", "close", "delete"]);
    expect(availableActions({ status: "approved", updated_at: JUST_NOW }, NOW)).toEqual(["close", "delete"]);
  });

  it("only lets a published or closed week be deleted", () => {
    expect(availableActions({ status: "published", updated_at: LONG_AGO }, NOW)).toEqual(["delete"]);
    expect(availableActions({ status: "closed", updated_at: LONG_AGO }, NOW)).toEqual(["delete"]);
  });

  it("always offers delete for a week that is not running", () => {
    for (const status of Constants.public.Enums.digest_status) {
      expect(availableActions({ status, updated_at: LONG_AGO }, NOW)).toContain("delete");
    }
  });
});

describe("retryTarget", () => {
  const base = { generation_completed_at: null, hasSelection: false, rejectedAt: null };

  it("restarts a failed week at the cheapest stage that still has its input", () => {
    expect(retryTarget({ ...base, status: "failed" })).toBe("collecting");
    expect(retryTarget({ ...base, status: "failed", hasSelection: true })).toBe("generating");
    expect(
      retryTarget({ ...base, status: "failed", hasSelection: true, generation_completed_at: "2026-10-31T10:00:00Z" }),
    ).toBe("rendering");
  });

  it("writes fresh copy for a sent-back week", () => {
    expect(retryTarget({ ...base, status: "rejected", hasSelection: true })).toBe("generating");
  });

  // A failed rewrite keeps the old copy and its checkpoint; retrying must not redraw the slides
  // from the copy the operator rejected.
  it("rewrites rather than redraws when the finished copy is the one that was sent back", () => {
    const rejectedCopy = {
      status: "failed" as const,
      hasSelection: true,
      generation_completed_at: "2026-10-31T10:00:00Z",
      rejectedAt: "2026-10-31T12:00:00Z",
    };
    expect(retryTarget(rejectedCopy)).toBe("generating");
    expect(retryTarget({ ...rejectedCopy, generation_completed_at: "2026-10-31T13:00:00Z" })).toBe("rendering");
  });

  it("has no target for a week that is neither failed nor sent back", () => {
    expect(retryTarget({ ...base, status: "approved" })).toBeNull();
  });
});
