// Integration tests for the scheduler job-state store. They exercise the real database
// because the guarantee under test — the atomic claim/stale-reclaim semantics — lives in
// the claim_scheduled_job Postgres function, not in TypeScript.
//
// Target: whatever SUPABASE_URL points at, using the service-role key from `.env`. Every
// row uses a randomized `test-job-*` name and is purged before and after the run, so no
// real job's state is touched.
//
// Running requires an explicit opt-in — SUPABASE_TEST_PROJECT=1 on top of the key —
// mirroring src/lib/digest/run-state.test.ts.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getJobState, releaseJob, tryAcquireJob } from "@/lib/scheduler/store";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { ScheduledJobRow, SchedulerResult } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const TEST_JOB_PREFIX = "test-job-";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the integration suite`);
  return value;
}

function serviceClient(): ServiceClient {
  return createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

/** A fresh, unused test job name per test, so concurrent test runs never collide. */
function nextJobName(): string {
  return `${TEST_JOB_PREFIX}${randomUUID()}`;
}

function unwrap<T>(result: SchedulerResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.data;
}

/** A freshly-claimed row always carries a `started_at`; narrows it without a non-null assertion. */
function requireStartedAt(row: ScheduledJobRow): string {
  if (row.started_at === null) throw new Error("expected a claimed job to have started_at set");
  return row.started_at;
}

/**
 * Postgres's textual timestamptz serialization ("+00:00", trailing-zero-trimmed
 * fractional seconds) does not byte-for-byte match `Date#toISOString()`'s "Z"-suffixed
 * fixed-precision format, even for the same instant — so timestamp assertions compare
 * parsed instants, not raw strings.
 */
function sameInstant(actual: string | null, expected: Date): void {
  if (actual === null) throw new Error("expected a timestamp, got null");
  expect(new Date(actual).getTime()).toBe(expected.getTime());
}

async function purgeTestJobs(): Promise<void> {
  const { error } = await serviceClient().from("scheduled_job").delete().like("name", `${TEST_JOB_PREFIX}%`);
  if (error) throw new Error(`failed to purge test jobs: ${error.message}`);
}

const STALE_AFTER_MS = 3 * 60 * 60 * 1000; // 3 hours, matching the plan's documented threshold

let db: ServiceClient;

describe.skipIf(!configured)("scheduler store (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeTestJobs();
  });
  afterAll(purgeTestJobs);

  describe("getJobState", () => {
    it("returns null for a job that has never been claimed", async () => {
      expect(unwrap(await getJobState(db, nextJobName()))).toBeNull();
    });
  });

  describe("tryAcquireJob", () => {
    it("claims a brand-new job with no existing row", async () => {
      const name = nextJobName();
      const now = new Date();

      const claimed = unwrap(await tryAcquireJob(db, name, now, STALE_AFTER_MS));

      expect(claimed.status).toBe("running");
      sameInstant(claimed.started_at, now);
    });

    it("claims an idle existing job", async () => {
      const name = nextJobName();
      const firstClaim = unwrap(await tryAcquireJob(db, name, new Date(), STALE_AFTER_MS));
      unwrap(await releaseJob(db, name, requireStartedAt(firstClaim), { completedAt: new Date() }));

      const secondNow = new Date(Date.now() + 60_000);
      const reclaimed = unwrap(await tryAcquireJob(db, name, secondNow, STALE_AFTER_MS));

      expect(reclaimed.status).toBe("running");
      sameInstant(reclaimed.started_at, secondNow);
    });

    it("refuses a job that is genuinely still running", async () => {
      const name = nextJobName();
      const startedAt = new Date();
      unwrap(await tryAcquireJob(db, name, startedAt, STALE_AFTER_MS));

      const secondAttempt = await tryAcquireJob(db, name, new Date(startedAt.getTime() + 1000), STALE_AFTER_MS);

      expect(secondAttempt.ok).toBe(false);
      if (secondAttempt.ok) return;
      expect(secondAttempt.reason).toBe("job_already_running");
    });

    it("reclaims a job whose lock has gone stale", async () => {
      const name = nextJobName();
      const staleStartedAt = new Date(Date.now() - STALE_AFTER_MS - 60_000);
      unwrap(await tryAcquireJob(db, name, staleStartedAt, STALE_AFTER_MS));

      const now = new Date();
      const reclaimed = unwrap(await tryAcquireJob(db, name, now, STALE_AFTER_MS));

      expect(reclaimed.status).toBe("running");
      sameInstant(reclaimed.started_at, now);
    });
  });

  describe("releaseJob", () => {
    it("records completion and returns the job to idle", async () => {
      const name = nextJobName();
      const claimed = unwrap(await tryAcquireJob(db, name, new Date(), STALE_AFTER_MS));
      const completedAt = new Date();

      const released = unwrap(await releaseJob(db, name, requireStartedAt(claimed), { completedAt, error: null }));

      expect(released.status).toBe("idle");
      expect(released.last_fired_at).toBe(claimed.started_at);
      sameInstant(released.last_completed_at, completedAt);
      expect(released.last_error).toBeNull();
    });

    it("records a failure's error message", async () => {
      const name = nextJobName();
      const claimed = unwrap(await tryAcquireJob(db, name, new Date(), STALE_AFTER_MS));

      const released = unwrap(
        await releaseJob(db, name, requireStartedAt(claimed), { completedAt: new Date(), error: "source unreachable" }),
      );

      expect(released.last_error).toBe("source unreachable");
    });

    it("rejects a release whose claim was already reclaimed by a newer invocation", async () => {
      const name = nextJobName();
      const staleStartedAt = new Date(Date.now() - STALE_AFTER_MS - 60_000);
      const originalClaim = unwrap(await tryAcquireJob(db, name, staleStartedAt, STALE_AFTER_MS));
      // A fresh invocation stale-reclaims the same job before the "original" one finishes.
      unwrap(await tryAcquireJob(db, name, new Date(), STALE_AFTER_MS));

      const lateRelease = await releaseJob(db, name, requireStartedAt(originalClaim), { completedAt: new Date() });

      expect(lateRelease.ok).toBe(false);
      if (lateRelease.ok) return;
      expect(lateRelease.reason).toBe("job_already_running");
    });
  });
});
