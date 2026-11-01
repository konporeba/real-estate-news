// The week list's filter/cursor parsing needs no database and always runs; loadWeekPage hits the
// real digest table behind the same SUPABASE_TEST_PROJECT opt-in as the other suites.
//
// SAFETY: synthetic weeks live in 2996, far enough ahead that they are always the newest rows the
// list query sees whatever real digests exist, and the purge only deletes that range.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadWeekPage, parseWeekPageQuery, WEEK_PAGE_SIZE, weekRowNote, weekViewHref } from "@/lib/digest/week-list";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { DigestStatus } from "@/types";

describe("parseWeekPageQuery", () => {
  it("reads a filter, a cursor and the week to leave out", () => {
    const query = parseWeekPageQuery(
      new URLSearchParams("view=needs&before=2026-10-26&exclude=e0e4a533-620d-48f9-9822-5826306dbc94"),
    );
    expect(query).toEqual({ view: "needs", before: "2026-10-26", exclude: "e0e4a533-620d-48f9-9822-5826306dbc94" });
  });

  it("falls back to the first page of all weeks for a hand-edited URL", () => {
    expect(parseWeekPageQuery(new URLSearchParams("view=bogus&before=last-week&exclude=nope"))).toEqual({
      view: "all",
      before: null,
      exclude: null,
    });
    expect(parseWeekPageQuery(new URLSearchParams())).toEqual({ view: "all", before: null, exclude: null });
  });
});

describe("weekViewHref", () => {
  it("keeps the bare dashboard URL for the default filter", () => {
    expect(weekViewHref("all")).toBe("/dashboard");
    expect(weekViewHref("published")).toBe("/dashboard?view=published");
  });
});

describe("weekRowNote", () => {
  it("explains the weeks that ended without a post", () => {
    expect(weekRowNote({ status: "closed", last_error: null })).toBe("Nothing was published");
    expect(weekRowNote({ status: "failed", last_error: "scoring truncated" })).toBe("scoring truncated");
    expect(weekRowNote({ status: "published", last_error: null })).toBe("");
  });
});

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!configured)("loadWeekPage (integration)", () => {
  let db: ServiceClient;
  const weekStart = (i: number) => new Date(Date.UTC(2996, 11, 25) - i * 7 * 86_400_000).toISOString().slice(0, 10);
  const weekEnd = (i: number) => new Date(Date.UTC(2996, 11, 31) - i * 7 * 86_400_000).toISOString().slice(0, 10);

  async function purge() {
    const { error } = await db
      .from("digest")
      .delete()
      .gte("window_start", "2996-01-01")
      .lte("window_start", "2996-12-31");
    if (error) throw new Error(error.message);
  }

  beforeAll(async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    db = createServiceClient(url, key);
    await purge();
    // Newest first: a failed week, an approved one, then a full page of closed ones. Inserted
    // directly — the transition guard only checks updates, and these are fixtures, not runs.
    const statuses: DigestStatus[] = ["failed", "approved", ...Array<DigestStatus>(WEEK_PAGE_SIZE).fill("closed")];
    const { error } = await db
      .from("digest")
      .insert(statuses.map((status, i) => ({ window_start: weekStart(i), window_end: weekEnd(i), status })));
    if (error) throw new Error(error.message);
  });
  afterAll(async () => {
    await purge();
  });

  it("returns the newest page and a cursor when there is more", async () => {
    const page = await loadWeekPage(db, { view: "all", before: null, exclude: null });
    if (!page.ok) throw new Error(page.message);

    expect(page.data.weeks).toHaveLength(WEEK_PAGE_SIZE);
    expect(page.data.weeks[0].window_start).toBe(weekStart(0));
    expect(page.data.nextBefore).toBe(weekStart(WEEK_PAGE_SIZE - 1));
  });

  it("continues from the cursor without repeating a week", async () => {
    const page = await loadWeekPage(db, { view: "all", before: weekStart(WEEK_PAGE_SIZE - 1), exclude: null });
    if (!page.ok) throw new Error(page.message);

    expect(page.data.weeks[0].window_start).toBe(weekStart(WEEK_PAGE_SIZE));
  });

  it("filters by view and leaves out the current week", async () => {
    const all = await loadWeekPage(db, { view: "all", before: null, exclude: null });
    if (!all.ok) throw new Error(all.message);
    const failedId = all.data.weeks[0].id;

    const needs = await loadWeekPage(db, { view: "needs", before: null, exclude: failedId });
    const published = await loadWeekPage(db, { view: "published", before: null, exclude: null });
    if (!needs.ok || !published.ok) throw new Error("query failed");

    expect(needs.data.weeks.map((w) => w.id)).not.toContain(failedId);
    expect(needs.data.weeks.every((w) => w.status !== "closed")).toBe(true);
    expect(published.data.weeks[0]).toMatchObject({ window_start: weekStart(1), status: "approved" });
  });
});
