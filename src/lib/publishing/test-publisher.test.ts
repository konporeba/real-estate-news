// The flag and id helpers need no database; the walkthrough below runs the real runPublish and
// record_publication behind the SUPABASE_TEST_PROJECT opt-in.
//
// SAFETY: the synthetic week lives in 2992 and only that year is purged.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { runPublish } from "@/lib/publishing/run";
import { isTestPostId, publishingEnabled, testPublishers } from "@/lib/publishing/test-publisher";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

describe("publishingEnabled", () => {
  it("is on only for the exact string true", () => {
    expect(publishingEnabled("true")).toBe(true);
    for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
      expect(publishingEnabled(value)).toBe(false);
    }
  });
});

describe("testPublishers", () => {
  it("reports success for every platform with a recognisable id", async () => {
    for (const publisher of Object.values(testPublishers())) {
      const attempt = await publisher.publish(["https://example.com/0.png"], "caption");
      expect(attempt.ok).toBe(true);
      expect(attempt.ok && isTestPostId(attempt.postId)).toBe(true);
    }
  });
});

describe("isTestPostId", () => {
  it("does not mistake a real post id or a missing one for a test", () => {
    expect(isTestPostId("17841400000000000")).toBe(false);
    expect(isTestPostId(null)).toBe(false);
  });
});

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!configured)("a simulated publish (integration)", () => {
  let db: ServiceClient;

  async function purge() {
    await db.from("digest").delete().gte("window_start", "2992-01-01").lte("window_start", "2992-12-31");
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

  it("finishes the week as published with test ids and contacts no network but the database", async () => {
    const created = await createDigest(db, { start: "2992-01-05", end: "2992-01-11" });
    if (!created.ok) throw new Error(created.message);
    const id = created.data.id;
    for (const to of [
      "ranking",
      "ready_for_selection",
      "generating",
      "rendering",
      "ready_for_approval",
      "approved",
    ] as const) {
      const moved = await transitionDigest(db, id, to);
      if (!moved.ok) throw new Error(moved.message);
    }
    const { error } = await db
      .from("selection")
      .insert({ digest_id: id, format: "carousel", platforms: ["facebook", "instagram"] });
    if (error) throw new Error(error.message);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const outcome = await runPublish(db, id, testPublishers());
    const socialCalls = fetchSpy.mock.calls.filter(([input]) =>
      /facebook|instagram|linkedin/.test(input instanceof Request ? input.url : String(input)),
    );
    fetchSpy.mockRestore();

    expect(outcome.ok).toBe(true);
    expect(socialCalls).toEqual([]);
    const { data: digest } = await db.from("digest").select("status").eq("id", id).single();
    const { data: rows } = await db.from("publication").select("status, post_id").eq("digest_id", id);
    expect(digest?.status).toBe("published");
    expect(rows).toHaveLength(2);
    expect(rows?.every((row) => row.status === "success" && isTestPostId(row.post_id))).toBe(true);
  });
});
