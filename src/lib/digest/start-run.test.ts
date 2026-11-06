// weekContaining needs no database and always runs; startRun round-trips to the real database behind
// the SUPABASE_TEST_PROJECT opt-in.
//
// SAFETY: `now` is pinned to a synthetic week in 2993, and only that year is purged.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { currentWeekWindow } from "@/lib/collection/window";
import { transitionDigest } from "@/lib/digest/run-state";
import { startRun, weekContaining } from "@/lib/digest/start-run";
import { loadWeekPage } from "@/lib/digest/week-list";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

describe("weekContaining", () => {
  it.each([
    "2026-11-06T12:00:00Z", // a Friday
    "2026-11-01T22:59:00Z", // Sunday 23:59 in Warsaw
    "2026-11-01T23:01:00Z", // Monday 00:01 in Warsaw, still Sunday in UTC
    "2026-03-29T00:30:00Z", // the night the clocks change
    "2026-10-25T00:30:00Z",
  ])("agrees with the collection stage's week for %s", (instant) => {
    expect(weekContaining(new Date(instant))).toEqual(currentWeekWindow(new Date(instant)));
  });
});

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!configured)("startRun (integration)", () => {
  let db: ServiceClient;
  const NOW = new Date("2993-06-15T12:00:00Z");

  async function purge() {
    await db.from("digest").delete().gte("window_start", "2993-01-01").lte("window_start", "2993-12-31");
  }

  beforeAll(async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    db = createServiceClient(url, key);
    await purge();
  });
  afterAll(async () => {
    await purge();
  });

  it("starts a collecting week, refuses a second, and allows another once the first has ended", async () => {
    const first = await startRun(db, NOW);
    if (!first.ok) throw new Error(first.message);
    const { data } = await db.from("digest").select("status").eq("id", first.digestId).single();
    expect(data?.status).toBe("collecting");

    expect(await startRun(db, NOW)).toMatchObject({ ok: false, reason: "already_running" });

    const closed = await transitionDigest(db, first.digestId, "closed");
    expect(closed.ok).toBe(true);
    const second = await startRun(db, NOW);
    if (!second.ok) throw new Error(second.message);

    // Two digests now share a week: the newer must lead the list, or it would not be "this week".
    const page = await loadWeekPage(db, { view: "all", before: "2994-01-01", exclude: null });
    if (!page.ok) throw new Error(page.message);
    expect(page.data.weeks[0].id).toBe(second.digestId);
  });
});
