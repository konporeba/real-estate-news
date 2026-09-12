// Integration tests for the S-07 approval gate. They exercise the real database, because
// everything under test lives in Postgres: the record_approval function's validations, its
// all-or-nothing write, the unique constraint that blocks a double decision, the FK cascade, and
// deny-by-default RLS on the new table.
//
// The central claim is atomicity, exactly as confirm_selection.test.ts's for the S-04 gate: every
// rejection case therefore asserts twice — that the call failed with the expected SQLSTATE, AND
// that the digest is still in `ready_for_approval` with no approval row behind it. A validation
// that rejected but left a half-written approval would pass the first assertion and fail the
// second.
//
// Target: whatever SUPABASE_URL points at, using the service-role key from `.env`. Every row is
// written into synthetic 3003 week windows (a year of its own — 2999 is confirm_selection's,
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
import type { ApprovalDecision, DigestWindow, RunStateResult } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks live in 3003 so they can never collide with a real digest or another suite. */
const TEST_WINDOW_FIRST = "3003-01-01";
const TEST_WINDOW_LAST = "3003-12-31";

let weekIndex = 0;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A fresh, unused test week. Each test takes its own so the unique index never collides. */
function nextWindow(): DigestWindow {
  const offset = weekIndex * 7;
  weekIndex += 1;
  return {
    start: isoDate(new Date(Date.UTC(3003, 0, 5 + offset))),
    end: isoDate(new Date(Date.UTC(3003, 0, 11 + offset))),
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

/** A digest parked exactly where the gate opens: `ready_for_approval`. */
async function readyForApprovalDigest(): Promise<string> {
  const digest = unwrap(await createDigest(db, nextWindow()));
  for (const status of ["ranking", "ready_for_selection", "generating", "rendering", "ready_for_approval"] as const) {
    unwrap(await transitionDigest(db, digest.id, status));
  }
  return digest.id;
}

function decide(digestId: string, decision: ApprovalDecision, note: string | null = null) {
  return db.rpc("record_approval", { p_digest_id: digestId, p_decision: decision, p_note: note });
}

/** Asserts nothing was written and the gate is still open — the atomicity half of each rejection. */
async function expectUnchanged(digestId: string): Promise<void> {
  expect(unwrap(await resumeDigest(db, digestId)).status).toBe("ready_for_approval");

  const { data } = await db.from("approval").select("id").eq("digest_id", digestId);
  expect(data).toEqual([]);
}

describe.skipIf(!configured)("record_approval (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeTestDigests();
  });
  afterAll(purgeTestDigests);

  describe("the happy path", () => {
    it("approves and transitions the digest", async () => {
      const digestId = await readyForApprovalDigest();

      const { data: approvalId, error } = await decide(digestId, "approved");
      expect(error).toBeNull();
      expect(approvalId).toBeTruthy();

      const { data: row } = await db
        .from("approval")
        .select("id, digest_id, decision, note")
        .eq("digest_id", digestId)
        .single();
      expect(row?.id).toBe(approvalId);
      expect(row?.decision).toBe("approved");
      expect(row?.note).toBeNull();

      expect(unwrap(await resumeDigest(db, digestId)).status).toBe("approved");
    });

    it("rejects with a note and transitions the digest", async () => {
      const digestId = await readyForApprovalDigest();

      const { data: approvalId, error } = await decide(digestId, "rejected", "the title reads clumsily");
      expect(error).toBeNull();

      const { data: row } = await db.from("approval").select("decision, note").eq("digest_id", digestId).single();
      expect(row?.decision).toBe("rejected");
      expect(row?.note).toBe("the title reads clumsily");

      expect(unwrap(await resumeDigest(db, digestId)).status).toBe("rejected");
      expect(approvalId).toBeTruthy();
    });

    it("rejects with no note", async () => {
      const digestId = await readyForApprovalDigest();

      const { error } = await decide(digestId, "rejected");
      expect(error).toBeNull();

      const { data: row } = await db.from("approval").select("note").eq("digest_id", digestId).single();
      expect(row?.note).toBeNull();
      expect(unwrap(await resumeDigest(db, digestId)).status).toBe("rejected");
    });
  });

  describe("note validation (AG003)", () => {
    it("accepts a note at exactly the 2000-character limit", async () => {
      const digestId = await readyForApprovalDigest();
      const note = "x".repeat(2000);

      const { error } = await decide(digestId, "rejected", note);

      expect(error).toBeNull();
    });

    it("rejects a note over the 2000-character limit", async () => {
      const digestId = await readyForApprovalDigest();
      const note = "x".repeat(2001);

      const { error } = await decide(digestId, "rejected", note);

      expect(error?.code).toBe("AG003");
      await expectUnchanged(digestId);
    });
  });

  describe("digest state", () => {
    it("refuses a digest that has not reached the gate", async () => {
      const digest = unwrap(await createDigest(db, nextWindow()));
      unwrap(await transitionDigest(db, digest.id, "ranking"));

      const { error } = await decide(digest.id, "approved");

      expect(error?.code).toBe("AG002");
      expect(unwrap(await resumeDigest(db, digest.id)).status).toBe("ranking");
    });

    it("refuses an unknown digest id", async () => {
      const { error } = await decide("00000000-0000-0000-0000-000000000000", "approved");

      expect(error?.code).toBe("AG001");
    });

    it("refuses a second decision — the gate has no undo", async () => {
      const digestId = await readyForApprovalDigest();
      const { error: first } = await decide(digestId, "approved");
      expect(first).toBeNull();

      // The status check fires first: the digest is now `approved`, not `ready_for_approval`, so
      // the second call is refused with AG002 before it ever reaches the unique constraint on
      // approval.digest_id. That constraint is the backstop underneath it, exactly as
      // confirm_selection's own status check outranks selection.digest_id's uniqueness.
      const { error: second } = await decide(digestId, "approved");

      expect(second?.code).toBe("AG002");
      const { data: approvals } = await db.from("approval").select("id").eq("digest_id", digestId);
      expect(approvals).toHaveLength(1);
    });
  });

  describe("schema guarantees", () => {
    it("cascades a digest delete to approval", async () => {
      const digestId = await readyForApprovalDigest();
      await decide(digestId, "approved");

      await db.from("digest").delete().eq("id", digestId);

      const { data: approvals } = await db.from("approval").select("id").eq("digest_id", digestId);
      expect(approvals).toEqual([]);
    });

    it("denies the anon/publishable key (RLS deny-by-default)", async () => {
      const anon = createClient<Database>(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_KEY"));

      const { data, error } = await anon.from("approval").select("id");
      // RLS with no policies yields an empty set; a hard denial is equally acceptable.
      if (error) {
        expect(error.message).toBeTruthy();
      } else {
        expect(data).toEqual([]);
      }
    });
  });
});
