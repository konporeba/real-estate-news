// Integration tests for the dashboard's week actions against the real database and slide bucket.
//
// SAFETY: synthetic weeks live in 2995 and only that range is purged; slide files are uploaded
// under each synthetic week's own id, and anything a failed case leaves is removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ASSET_BUCKET } from "@/lib/digest/assets";
import { applyWeekAction } from "@/lib/digest/manage-week";
import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { DigestRun, RunStateResult } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

let weekIndex = 0;
function nextWeek(): { start: string; end: string } {
  const start = Date.UTC(2995, 0, 2) + weekIndex * 7 * 86_400_000; // 2995-01-02 is a Monday
  weekIndex += 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: iso(start), end: iso(start + 6 * 86_400_000) };
}

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.data;
}

describe.skipIf(!configured)("applyWeekAction (integration)", () => {
  let db: ServiceClient;
  const created: string[] = [];
  // Well past RUNNING_WINDOW_MS, so a week transitioned a moment ago counts as not running.
  const LATER = new Date(Date.now() + 4 * 60 * 60 * 1000);

  async function week(...path: DigestRun["status"][]): Promise<DigestRun> {
    let digest = unwrap(await createDigest(db, nextWeek()));
    created.push(digest.id);
    for (const to of path) digest = unwrap(await transitionDigest(db, digest.id, to));
    return digest;
  }

  async function purge() {
    await db.from("digest").delete().gte("window_start", "2995-01-01").lte("window_start", "2995-12-31");
  }

  beforeAll(async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    db = createServiceClient(url, key);
    await purge();
  });
  afterAll(async () => {
    const bucket = db.storage.from(ASSET_BUCKET);
    for (const id of created) {
      const { data } = await bucket.list(id);
      if (data && data.length > 0) await bucket.remove(data.map((f) => `${id}/${f.name}`));
    }
    await purge();
  });

  it("deletes a week, everything under it, and its slide images", async () => {
    const digest = await week("failed");
    const { error: clusterError } = await db.from("cluster").insert({ digest_id: digest.id });
    if (clusterError) throw new Error(clusterError.message);
    const bucket = db.storage.from(ASSET_BUCKET);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    for (const name of ["0.png", "1.png"]) {
      const { error } = await bucket.upload(`${digest.id}/${name}`, png, { contentType: "image/png", upsert: true });
      if (error) throw new Error(error.message);
    }

    const result = await applyWeekAction(db, digest.id, "delete", LATER);

    expect(result).toEqual({ ok: true, week: null });
    const { data: row } = await db.from("digest").select("id").eq("id", digest.id).maybeSingle();
    const { count } = await db.from("cluster").select("id", { count: "exact", head: true }).eq("digest_id", digest.id);
    const { data: files } = await bucket.list(digest.id);
    expect(row).toBeNull();
    expect(count).toBe(0);
    expect(files).toEqual([]);
  });

  it("closes an approved week so the Tuesday publish can never post it, keeping a failure's reason", async () => {
    const approved = await week(
      "ranking",
      "ready_for_selection",
      "generating",
      "rendering",
      "ready_for_approval",
      "approved",
    );
    const failed = unwrap(await transitionDigest(db, (await week()).id, "failed", { lastError: "boom" }));

    const closedApproved = await applyWeekAction(db, approved.id, "close", LATER);
    const closedFailed = await applyWeekAction(db, failed.id, "close", LATER);

    expect(closedApproved).toMatchObject({ ok: true, week: { status: "closed" } });
    expect(closedFailed).toMatchObject({ ok: true, week: { status: "closed", last_error: "boom" } });
  });

  it("retries a failed collection from the top, clearing the old error", async () => {
    const failed = unwrap(await transitionDigest(db, (await week()).id, "failed", { lastError: "no articles" }));

    const result = await applyWeekAction(db, failed.id, "retry", LATER);

    expect(result).toMatchObject({ ok: true, week: { status: "collecting", last_error: null } });
  });

  it("refuses to touch a week a worker is running right now", async () => {
    const running = await week("ranking");

    const result = await applyWeekAction(db, running.id, "delete", new Date());

    expect(result).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(result.ok || result.message).toMatch(/being worked on right now/);
  });

  it("refuses an action the week does not allow, and a week that is gone", async () => {
    const approved = await week(
      "ranking",
      "ready_for_selection",
      "generating",
      "rendering",
      "ready_for_approval",
      "approved",
    );

    expect(await applyWeekAction(db, approved.id, "retry", LATER)).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await applyWeekAction(db, "00000000-0000-4000-8000-000000000000", "close", LATER)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });
});
