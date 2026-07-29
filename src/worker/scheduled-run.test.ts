// Integration tests for the orchestration entrypoint's due-check/claim/release loop.
// Runs against the real database (mirroring src/lib/scheduler/store.test.ts), but drives
// `runScheduledJobs` with a FAKE job action rather than the real collect/rank chain —
// invoking the real chain here would hit live RSS feeds and spend real LLM money on every
// test run, which is exactly what the opt-in live-smoke tests exist to avoid doing by default.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ScheduledJobDefinition } from "@/lib/scheduler/registry";
import { DEFAULT_STALE_AFTER_MS, releaseJob, tryAcquireJob } from "@/lib/scheduler/store";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { runScheduledJobs, type JobAction, type JobOutcome } from "@/worker/scheduled-run";
import type { ScheduledJobRow } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const TEST_JOB_PREFIX = "test-scheduled-run-";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the integration suite`);
  return value;
}

function serviceClient(): ServiceClient {
  return createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

function nextJobName(): string {
  return `${TEST_JOB_PREFIX}${randomUUID()}`;
}

/** A freshly-claimed row always carries a `started_at`; narrows it without a non-null assertion. */
function requireStartedAt(row: ScheduledJobRow): string {
  if (row.started_at === null) throw new Error("expected a claimed job to have started_at set");
  return row.started_at;
}

async function purgeTestJobs(): Promise<void> {
  const { error } = await serviceClient().from("scheduled_job").delete().like("name", `${TEST_JOB_PREFIX}%`);
  if (error) throw new Error(`failed to purge test jobs: ${error.message}`);
}

// Wednesday 2026-07-29T12:00:00Z; its most recent Sunday-17:00-Europe/Warsaw occurrence is
// 2026-07-26T15:00:00Z (verified in src/lib/scheduler/schedule.test.ts).
const NOW = new Date("2026-07-29T12:00:00Z");
const MOST_RECENT_DUE_INSTANT = new Date("2026-07-26T15:00:00.000Z");
const SCHEDULE = { dayOfWeek: 0 as const, hour: 17, minute: 0 };

/** Records every call so a test can assert whether the action ran, and how many times. */
function fakeAction(outcome: JobOutcome): { action: JobAction; callCount: () => number } {
  let calls = 0;
  return {
    action: () => {
      calls += 1;
      return Promise.resolve(outcome);
    },
    callCount: () => calls,
  };
}

let db: ServiceClient;

describe.skipIf(!configured)("scheduled-run (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeTestJobs();
  });
  afterAll(purgeTestJobs);

  it("does not invoke the action when the job is not due", async () => {
    const name = nextJobName();
    // Already fired (claimed and released) at the most recent scheduled instant —
    // nothing is due.
    const claimed = await tryAcquireJob(db, name, MOST_RECENT_DUE_INSTANT, DEFAULT_STALE_AFTER_MS);
    if (!claimed.ok) throw new Error(`setup failed: ${claimed.reason}`);
    await releaseJob(db, name, requireStartedAt(claimed.data), { completedAt: new Date() });

    const { action, callCount } = fakeAction({ ok: true });
    const jobs: ScheduledJobDefinition[] = [{ name, schedule: SCHEDULE }];

    const allOk = await runScheduledJobs(db, jobs, { [name]: action }, NOW);

    expect(allOk).toBe(true);
    expect(callCount()).toBe(0);
  });

  it("claims and runs a due job, recording its outcome", async () => {
    const name = nextJobName();
    const { action, callCount } = fakeAction({ ok: true });
    const jobs: ScheduledJobDefinition[] = [{ name, schedule: SCHEDULE }];

    const allOk = await runScheduledJobs(db, jobs, { [name]: action }, NOW);

    expect(allOk).toBe(true);
    expect(callCount()).toBe(1);

    const { data: row } = await db.from("scheduled_job").select("*").eq("name", name).single();
    expect(row?.status).toBe("idle");
    expect(row?.last_error).toBeNull();
    expect(row?.last_completed_at).not.toBeNull();
  });

  it("records a failed action's error and reports overall failure", async () => {
    const name = nextJobName();
    const { action } = fakeAction({ ok: false, error: "source unreachable" });
    const jobs: ScheduledJobDefinition[] = [{ name, schedule: SCHEDULE }];

    const allOk = await runScheduledJobs(db, jobs, { [name]: action }, NOW);

    expect(allOk).toBe(false);

    const { data: row } = await db.from("scheduled_job").select("*").eq("name", name).single();
    expect(row?.status).toBe("idle");
    expect(row?.last_error).toBe("source unreachable");
  });

  it("releases the claim and records the error when the action throws", async () => {
    const name = nextJobName();
    const throwingAction: JobAction = () => {
      throw new Error("boom: unexpected refusal");
    };
    const jobs: ScheduledJobDefinition[] = [{ name, schedule: SCHEDULE }];

    const allOk = await runScheduledJobs(db, jobs, { [name]: throwingAction }, NOW);

    expect(allOk).toBe(false);

    const { data: row } = await db.from("scheduled_job").select("*").eq("name", name).single();
    expect(row?.status).toBe("idle");
    expect(row?.last_error).toContain("boom: unexpected refusal");
  });

  it("skips a job that is genuinely still running, without invoking the action", async () => {
    const name = nextJobName();
    // Simulate another invocation currently mid-run: claimed a moment ago, well within
    // the stale threshold.
    await tryAcquireJob(db, name, new Date(NOW.getTime() - 60_000), DEFAULT_STALE_AFTER_MS);

    const { action, callCount } = fakeAction({ ok: true });
    const jobs: ScheduledJobDefinition[] = [{ name, schedule: SCHEDULE }];

    const allOk = await runScheduledJobs(db, jobs, { [name]: action }, NOW);

    expect(allOk).toBe(true);
    expect(callCount()).toBe(0);

    const { data: row } = await db.from("scheduled_job").select("*").eq("name", name).single();
    expect(row?.status).toBe("running");
  });

  it("reclaims and runs a job whose lock has gone stale", async () => {
    const name = nextJobName();
    const staleStartedAt = new Date(NOW.getTime() - DEFAULT_STALE_AFTER_MS - 60_000);
    await tryAcquireJob(db, name, staleStartedAt, DEFAULT_STALE_AFTER_MS);

    const { action, callCount } = fakeAction({ ok: true });
    const jobs: ScheduledJobDefinition[] = [{ name, schedule: SCHEDULE }];

    const allOk = await runScheduledJobs(db, jobs, { [name]: action }, NOW);

    expect(allOk).toBe(true);
    expect(callCount()).toBe(1);

    const { data: row } = await db.from("scheduled_job").select("*").eq("name", name).single();
    expect(row?.status).toBe("idle");
  });
});
