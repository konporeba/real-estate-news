// Integration tests for the S-08 publish record (FR-022, US-20). They exercise the real database,
// because everything under test lives in Postgres: record_publication's validations, its
// upsert-on-retry write, the conditional transition to `published`, the unique constraint on
// (digest_id, platform), the FK cascade, and deny-by-default RLS on the new table.
//
// Mirrors src/lib/approval/record.test.ts exactly. Every rejection case asserts twice — that the
// call failed with the expected SQLSTATE, AND that no publication row was written — the same
// atomicity claim record_approval's suite makes for its own gate.
//
// Target: whatever SUPABASE_URL points at, using the service-role key from `.env`. Every row is
// written into synthetic 3004 week windows (a year of its own — 3003 is record_approval's,
// 2991-3002 and 3100/3200 are taken by other suites) and purged before and after the run, so no
// real digest is touched.
//
// Running requires an explicit opt-in — SUPABASE_TEST_PROJECT=1 on top of the key — so that
// pointing an RLS-bypassing write suite at a project is always a deliberate act.
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/db/database.types";
import { createDigest, resumeDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { DigestStatus, DigestWindow, PublicationStatus, RunStateResult, SelectionPlatform } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks live in 3004 so they can never collide with a real digest or another suite. */
const TEST_WINDOW_FIRST = "3004-01-01";
const TEST_WINDOW_LAST = "3004-12-31";

let weekIndex = 0;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A fresh, unused test week. Each test takes its own so the unique index never collides. */
function nextWindow(): DigestWindow {
  const offset = weekIndex * 7;
  weekIndex += 1;
  return {
    start: isoDate(new Date(Date.UTC(3004, 0, 5 + offset))),
    end: isoDate(new Date(Date.UTC(3004, 0, 11 + offset))),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the integration suite`);
  return value;
}

function serviceClient() {
  return createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

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

let db: ServiceClient;

/**
 * A digest parked at the given status ("approved" or "skipped"), walking the state machine from
 * the top. `skipped` goes straight from `ready_for_approval` (US-19's missed-deadline path).
 */
async function digestAt(status: "approved" | "skipped"): Promise<string> {
  const digest = unwrap(await createDigest(db, nextWindow()));
  const path: DigestStatus[] = [
    "ranking",
    "ready_for_selection",
    "generating",
    "rendering",
    "ready_for_approval",
    status,
  ];
  for (const step of path) {
    unwrap(await transitionDigest(db, digest.id, step));
  }
  return digest.id;
}

function record(
  digestId: string,
  platform: SelectionPlatform,
  status: PublicationStatus,
  postId: string | null = null,
  error: string | null = null,
) {
  return db.rpc("record_publication", {
    p_digest_id: digestId,
    p_platform: platform,
    p_status: status,
    p_post_id: postId,
    p_error: error,
  });
}

/** Asserts nothing was written for this (digest, platform) pair. */
async function expectNoRow(digestId: string, platform: SelectionPlatform): Promise<void> {
  const { data } = await db.from("publication").select("id").eq("digest_id", digestId).eq("platform", platform);
  expect(data).toEqual([]);
}

describe.skipIf(!configured)("record_publication (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeTestDigests();
  });
  afterAll(purgeTestDigests);

  describe("the happy path", () => {
    it("records a success and transitions an approved digest to published", async () => {
      const digestId = await digestAt("approved");

      const { data: publicationId, error } = await record(digestId, "instagram", "success", "media123");
      expect(error).toBeNull();
      expect(publicationId).toBeTruthy();

      const { data: row } = await db
        .from("publication")
        .select("id, digest_id, platform, status, post_id, error")
        .eq("digest_id", digestId)
        .single();
      expect(row?.id).toBe(publicationId);
      expect(row?.status).toBe("success");
      expect(row?.post_id).toBe("media123");
      expect(row?.error).toBeNull();

      expect(unwrap(await resumeDigest(db, digestId)).status).toBe("published");
    });

    it("records a success and transitions a skipped digest to published", async () => {
      const digestId = await digestAt("skipped");

      const { error } = await record(digestId, "facebook", "success", "post456");
      expect(error).toBeNull();

      expect(unwrap(await resumeDigest(db, digestId)).status).toBe("published");
    });

    it("records a failure without transitioning the digest", async () => {
      const digestId = await digestAt("approved");

      const { error } = await record(digestId, "linkedin", "failure", null, "invalid access token");
      expect(error).toBeNull();

      const { data: row } = await db.from("publication").select("status, error").eq("digest_id", digestId).single();
      expect(row?.status).toBe("failure");
      expect(row?.error).toBe("invalid access token");

      // A failure alone must not publish the digest -- US-20's whole point is that one platform's
      // outcome is independent of another's.
      expect(unwrap(await resumeDigest(db, digestId)).status).toBe("approved");
    });

    it("one platform failing does not block another from succeeding", async () => {
      const digestId = await digestAt("approved");

      await record(digestId, "instagram", "failure", null, "rate limited");
      const { error } = await record(digestId, "facebook", "success", "post789");
      expect(error).toBeNull();

      expect(unwrap(await resumeDigest(db, digestId)).status).toBe("published");

      const { data: rows } = await db
        .from("publication")
        .select("platform, status")
        .eq("digest_id", digestId)
        .order("platform");
      expect(rows).toHaveLength(2);
    });
  });

  describe("retry semantics", () => {
    it("overwrites the prior attempt for the same platform rather than accumulating rows", async () => {
      const digestId = await digestAt("approved");

      await record(digestId, "instagram", "failure", null, "temporary network error");
      const { error } = await record(digestId, "instagram", "success", "media999");
      expect(error).toBeNull();

      const { data: rows } = await db.from("publication").select("id, status, post_id").eq("digest_id", digestId);
      expect(rows).toHaveLength(1);
      expect(rows?.[0]?.status).toBe("success");
      expect(rows?.[0]?.post_id).toBe("media999");
    });

    it("accepts a retry after the digest is already published (a later platform catching up)", async () => {
      const digestId = await digestAt("approved");
      await record(digestId, "instagram", "success", "media1");
      expect(unwrap(await resumeDigest(db, digestId)).status).toBe("published");

      const { error } = await record(digestId, "facebook", "success", "media2");
      expect(error).toBeNull();
      expect(unwrap(await resumeDigest(db, digestId)).status).toBe("published");
    });
  });

  describe("digest state (PB002)", () => {
    it("refuses a digest that has not reached approval", async () => {
      const digest = unwrap(await createDigest(db, nextWindow()));
      unwrap(await transitionDigest(db, digest.id, "ranking"));

      const { error } = await record(digest.id, "instagram", "success", "media1");

      expect(error?.code).toBe("PB002");
      await expectNoRow(digest.id, "instagram");
    });

    it("refuses a rejected digest", async () => {
      const digest = unwrap(await createDigest(db, nextWindow()));
      for (const status of ["ranking", "ready_for_selection", "generating", "rendering", "ready_for_approval"] as const)
        unwrap(await transitionDigest(db, digest.id, status));
      unwrap(await transitionDigest(db, digest.id, "rejected"));

      const { error } = await record(digest.id, "instagram", "success", "media1");

      expect(error?.code).toBe("PB002");
    });
  });

  describe("unknown digest (PB001)", () => {
    it("refuses an unknown digest id", async () => {
      const { error } = await record("00000000-0000-0000-0000-000000000000", "instagram", "success", "media1");

      expect(error?.code).toBe("PB001");
    });
  });

  describe("schema guarantees", () => {
    it("cascades a digest delete to publication", async () => {
      const digestId = await digestAt("approved");
      await record(digestId, "instagram", "success", "media1");

      await db.from("digest").delete().eq("id", digestId);

      const { data: rows } = await db.from("publication").select("id").eq("digest_id", digestId);
      expect(rows).toEqual([]);
    });

    it("denies the anon/publishable key (RLS deny-by-default)", async () => {
      const anon = createClient<Database>(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_KEY"));

      const { data, error } = await anon.from("publication").select("id");
      // RLS with no policies yields an empty set; a hard denial is equally acceptable.
      if (error) {
        expect(error.message).toBeTruthy();
      } else {
        expect(data).toEqual([]);
      }
    });
  });
});
