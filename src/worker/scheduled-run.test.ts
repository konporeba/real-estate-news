// Integration tests for the orchestration entrypoint's due-check/claim/release loop.
// Runs against the real database (mirroring src/lib/scheduler/store.test.ts), but drives
// `runScheduledJobs` with a FAKE job action rather than the real collect/rank chain —
// invoking the real chain here would hit live RSS feeds and spend real LLM money on every
// test run, which is exactly what the opt-in live-smoke tests exist to avoid doing by default.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SCHEDULED_JOBS, type ScheduledJobDefinition } from "@/lib/scheduler/registry";
import { DEFAULT_STALE_AFTER_MS, releaseJob, tryAcquireJob } from "@/lib/scheduler/store";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import {
  JOB_ACTIONS,
  reportHeartbeat,
  runScheduledJobs,
  type JobAction,
  type JobOutcome,
} from "@/worker/scheduled-run";
import type { ScheduledJobRow } from "@/types";

// No DB dependency, unlike the integration suites below — reportHeartbeat only calls fetch.
describe("reportHeartbeat", () => {
  it("resolves without throwing when pingUrl is undefined", async () => {
    const fetchImpl = vi.fn();
    await expect(reportHeartbeat(fetchImpl, undefined, true)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves without throwing when fetch rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(reportHeartbeat(fetchImpl, "https://hc-ping.com/abc", true)).resolves.toBeUndefined();
  });

  it("GETs the plain ping URL when ok is true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await reportHeartbeat(fetchImpl, "https://hc-ping.com/abc", true);
    expect(fetchImpl).toHaveBeenCalledWith("https://hc-ping.com/abc");
  });

  it("GETs the /fail-suffixed URL when ok is false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await reportHeartbeat(fetchImpl, "https://hc-ping.com/abc", false);
    expect(fetchImpl).toHaveBeenCalledWith("https://hc-ping.com/abc/fail");
  });
});

// Needs no database: a drift guard confirming every registered job (including S-08's "publish")
// has a matching real action, the same way F-01's transition-guard test keeps the SQL and TS
// digest transition tables from silently diverging.
describe("JOB_ACTIONS", () => {
  it("has a real action for every job in SCHEDULED_JOBS", () => {
    for (const job of SCHEDULED_JOBS) {
      expect(JOB_ACTIONS[job.name]).toBeTypeOf("function");
    }
  });

  it("registers no action for a job the registry does not know about", () => {
    const registeredNames = new Set(SCHEDULED_JOBS.map((job) => job.name));
    for (const name of Object.keys(JOB_ACTIONS)) {
      expect(registeredNames.has(name)).toBe(true);
    }
  });
});

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

  // S-07/FR-021: the reminder's real schedule is Monday 09:00, not Sunday 17:00 -- this confirms
  // the due-check/claim/release loop is genuinely generic across weekdays, not just proven against
  // the one schedule every other test above happens to share.
  it("claims and runs a job on a different weekday's schedule (the approval-reminder's own)", async () => {
    const name = nextJobName();
    const mondaySchedule = { dayOfWeek: 1 as const, hour: 9, minute: 0 };
    const { action, callCount } = fakeAction({ ok: true });
    const jobs: ScheduledJobDefinition[] = [{ name, schedule: mondaySchedule }];

    // 2026-07-29 is itself a Wednesday; NOW's own most-recent-Monday-09:00 differs from
    // MOST_RECENT_DUE_INSTANT (Sunday's), so this exercises a genuinely different due-check.
    const allOk = await runScheduledJobs(db, jobs, { [name]: action }, NOW);

    expect(allOk).toBe(true);
    expect(callCount()).toBe(1);

    const { data: row } = await db.from("scheduled_job").select("*").eq("name", name).single();
    expect(row?.status).toBe("idle");
    expect(row?.last_error).toBeNull();
  });
});
