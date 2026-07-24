// Integration tests for the run-state contract. They exercise the real database, because
// the guarantees under test (transition trigger, partial unique index, FK cascade, RLS)
// live in Postgres, not in TypeScript.
//
// Target: whatever SUPABASE_URL points at, using the service-role key from `.env`. Every
// row is written into synthetic 1970 week windows and purged before and after the run,
// so no real digest data is touched.
//
// Running requires an explicit opt-in — SUPABASE_TEST_PROJECT=1 on top of the key — so
// that pointing an RLS-bypassing write suite at a project is always a deliberate act and
// never something a bare `npm test` does by inheriting whatever `.env` happens to hold.
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/db/database.types";
import {
  createDigest,
  getActiveDigestForWeek,
  markStageComplete,
  resumeDigest,
  transitionDigest,
} from "@/lib/digest/run-state";
import { createServiceClient } from "@/lib/supabase-admin";
import type { DigestWindow, RunStateResult } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks live in 1970 so they can never collide with a real digest. */
const TEST_WINDOW_FIRST = "1970-01-01";
const TEST_WINDOW_LAST = "1970-12-31";

let weekIndex = 0;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A fresh, unused test week. Each test takes its own so the unique index never collides. */
function nextWindow(): DigestWindow {
  const offset = weekIndex * 7;
  weekIndex += 1;
  return {
    start: isoDate(new Date(Date.UTC(1970, 0, 5 + offset))),
    end: isoDate(new Date(Date.UTC(1970, 0, 11 + offset))),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the integration suite`);
  return value;
}

function serviceClient() {
  const client = createServiceClient();
  if (!client) throw new Error("service-role client is unavailable");
  return client;
}

/** Asserts a run-state call succeeded and returns its payload. */
function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.data;
}

async function purgeTestDigests(): Promise<void> {
  const { error } = await serviceClient()
    .from("digest")
    .delete()
    .gte("window_start", TEST_WINDOW_FIRST)
    .lte("window_start", TEST_WINDOW_LAST);
  if (error) throw new Error(`failed to purge test digests: ${error.message}`);
}

describe.skipIf(!configured)("run-state (integration)", () => {
  // A previous aborted run could leave a live 1970 digest behind, which the partial
  // unique index would then reject — purge on both ends.
  beforeAll(purgeTestDigests);
  afterAll(purgeTestDigests);

  describe("createDigest", () => {
    it("inserts a collecting digest with zero cost and no checkpoints", async () => {
      const window = nextWindow();
      const digest = unwrap(await createDigest(window));

      expect(digest.status).toBe("collecting");
      expect(digest.window_start).toBe(window.start);
      expect(digest.window_end).toBe(window.end);
      expect(digest.cost_usd).toBe(0);
      expect(digest.collection_completed_at).toBeNull();
      expect(digest.ranking_completed_at).toBeNull();
      expect(digest.translation_completed_at).toBeNull();
      expect(digest.last_error).toBeNull();
    });

    it("rejects a second live digest for the same week", async () => {
      const window = nextWindow();
      unwrap(await createDigest(window));

      const collision = await createDigest(window);

      expect(collision.ok).toBe(false);
      if (collision.ok) return;
      expect(collision.reason).toBe("active_digest_exists");
    });

    it("frees the week once the digest reaches a terminal state", async () => {
      const window = nextWindow();
      const first = unwrap(await createDigest(window));

      expect(unwrap(await getActiveDigestForWeek(window))?.id).toBe(first.id);

      unwrap(await transitionDigest(first.id, "failed", { lastError: "collection timed out" }));

      expect(unwrap(await getActiveDigestForWeek(window))).toBeNull();
      const retriggered = unwrap(await createDigest(window));
      expect(retriggered.id).not.toBe(first.id);
    });
  });

  describe("transitionDigest", () => {
    it("persists a legal transition", async () => {
      const digest = unwrap(await createDigest(nextWindow()));

      const moved = unwrap(await transitionDigest(digest.id, "ranking"));

      expect(moved.status).toBe("ranking");
      expect(unwrap(await resumeDigest(digest.id)).status).toBe("ranking");
    });

    it("records last_error on failure and clears it on re-trigger", async () => {
      const digest = unwrap(await createDigest(nextWindow()));

      const failed = unwrap(await transitionDigest(digest.id, "failed", { lastError: "feed unreachable" }));
      expect(failed.last_error).toBe("feed unreachable");

      const retried = unwrap(await transitionDigest(digest.id, "collecting"));
      expect(retried.status).toBe("collecting");
      expect(retried.last_error).toBeNull();
    });

    it("leaves an existing last_error alone when the caller supplies none", async () => {
      const digest = unwrap(await createDigest(nextWindow()));
      await serviceClient().from("digest").update({ last_error: "earlier failure detail" }).eq("id", digest.id);

      const failed = unwrap(await transitionDigest(digest.id, "failed"));

      expect(failed.last_error).toBe("earlier failure detail");
    });

    it("rejects an illegal transition and leaves the row untouched", async () => {
      const digest = unwrap(await createDigest(nextWindow()));

      const result = await transitionDigest(digest.id, "published");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("illegal_transition");
      expect(unwrap(await resumeDigest(digest.id)).status).toBe("collecting");
    });

    it("is rejected by the database trigger even when the app guard is bypassed", async () => {
      const digest = unwrap(await createDigest(nextWindow()));

      const { error } = await serviceClient().from("digest").update({ status: "published" }).eq("id", digest.id);

      expect(error).not.toBeNull();
      expect(error?.message).toContain("illegal digest transition");
      expect(unwrap(await resumeDigest(digest.id)).status).toBe("collecting");
    });

    it("reports not_found for an unknown id", async () => {
      const result = await transitionDigest("00000000-0000-0000-0000-000000000000", "ranking");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("not_found");
    });
  });

  describe("markStageComplete", () => {
    it("writes a checkpoint without tripping the transition guard", async () => {
      const digest = unwrap(await createDigest(nextWindow()));
      const completedAt = new Date("1970-01-08T12:00:00.000Z");

      const checkpointed = unwrap(await markStageComplete(digest.id, "collection", completedAt));

      expect(checkpointed.status).toBe("collecting");
      expect(checkpointed.collection_completed_at).not.toBeNull();
      expect(new Date(checkpointed.collection_completed_at ?? "").toISOString()).toBe(completedAt.toISOString());
    });
  });

  describe("resumeDigest", () => {
    it("returns the persisted state and checkpoints a restarted worker would resume from", async () => {
      const digest = unwrap(await createDigest(nextWindow()));
      await markStageComplete(digest.id, "collection");
      unwrap(await transitionDigest(digest.id, "ranking"));

      // Nothing is held in memory: this is exactly what a worker sees on boot.
      const resumed = unwrap(await resumeDigest(digest.id));

      expect(resumed.status).toBe("ranking");
      expect(resumed.collection_completed_at).not.toBeNull();
      expect(resumed.ranking_completed_at).toBeNull();
    });
  });

  describe("schema guarantees", () => {
    it("cascades a digest delete to its cluster and article rows", async () => {
      const client = serviceClient();
      const digest = unwrap(await createDigest(nextWindow()));

      const { data: cluster, error: clusterError } = await client
        .from("cluster")
        .insert({ digest_id: digest.id })
        .select()
        .single();
      expect(clusterError).toBeNull();

      const { error: articleError } = await client.from("article").insert({
        digest_id: digest.id,
        cluster_id: cluster?.id,
        source_name: "Test Source",
        source_url: "https://example.test/cascade",
        original_title: "Cascade check",
      });
      expect(articleError).toBeNull();

      await client.from("digest").delete().eq("id", digest.id);

      const { data: clusters } = await client.from("cluster").select("id").eq("digest_id", digest.id);
      const { data: articles } = await client.from("article").select("id").eq("digest_id", digest.id);
      expect(clusters).toEqual([]);
      expect(articles).toEqual([]);
    });

    it("denies the anon/publishable key (RLS deny-by-default)", async () => {
      unwrap(await createDigest(nextWindow()));

      const anon = createClient<Database>(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_KEY"));
      const { data, error } = await anon.from("digest").select("id");

      // RLS with no policies yields an empty set; a hard denial is equally acceptable.
      if (error) {
        expect(error.message).toBeTruthy();
      } else {
        expect(data).toEqual([]);
      }
    });
  });
});
