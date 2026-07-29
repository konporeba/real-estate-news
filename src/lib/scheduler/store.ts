// SHARED, RUNTIME-NEUTRAL. Takes its Supabase client as a parameter, like
// src/lib/digest/run-state.ts, so this module resolves in the Astro runtime, in Vitest,
// and in the plain Node worker alike.
//
// F-05: per-job scheduling state — is a named job currently running, when did it last
// fire/complete. `tryAcquireJob` is the only write path that can transition a job into
// `running`; PostgREST cannot express "insert, or update only if idle/stale" as a single
// conditional upsert, so that half lives in the `claim_scheduled_job` Postgres function
// (supabase/migrations/20260729180000_scheduled_job_state.sql), mirroring the
// increment_digest_cost precedent. `releaseJob` is a plain conditional update, which
// PostgREST expresses fine on its own.
import type { PostgrestError } from "@supabase/supabase-js";

import type { ServiceClient } from "@/lib/supabase-service";
import type { ScheduledJobRow, SchedulerError, SchedulerResult } from "@/types";

function fail(reason: SchedulerError["reason"], message: string): SchedulerError {
  return { ok: false, reason, message };
}

function databaseError(error: PostgrestError): SchedulerError {
  return fail("database_error", `${error.code}: ${error.message}`);
}

/** A job's persisted state, or `null` when it has never been claimed. */
export async function getJobState(
  client: ServiceClient,
  name: string,
): Promise<SchedulerResult<ScheduledJobRow | null>> {
  const { data, error } = await client.from("scheduled_job").select("*").eq("name", name).maybeSingle();

  if (error) return databaseError(error);
  return { ok: true, data };
}

/**
 * Atomically claim a job for running.
 *
 * Succeeds (inserting a first-ever row, or flipping an existing one to `running`) when the
 * row is absent, `idle`, or `running` with a `started_at` older than `staleAfterMs` — a
 * crashed prior invocation. Otherwise a genuinely active run holds it, and this returns
 * `job_already_running` rather than throwing: that is an expected, handled outcome, not a
 * failure.
 */
export async function tryAcquireJob(
  client: ServiceClient,
  name: string,
  now: Date,
  staleAfterMs: number,
): Promise<SchedulerResult<ScheduledJobRow>> {
  const { data, error } = await client.rpc("claim_scheduled_job", {
    p_name: name,
    p_now: now.toISOString(),
    p_stale_after_seconds: Math.round(staleAfterMs / 1000),
  });

  if (error) return databaseError(error);
  if (data.length === 0) return fail("job_already_running", `job "${name}" is already running`);
  return { ok: true, data: data[0] };
}

/**
 * Release a job claimed by `tryAcquireJob`, recording its outcome.
 *
 * Scoped to `started_at = claimedStartedAt` (the value returned by the matching
 * `tryAcquireJob` call), not just `name` — mirroring `transitionDigest`'s
 * `.eq("status", from)` optimistic-concurrency pattern. This is what stops a genuinely
 * slow (not crashed) run, whose lock was stale-reclaimed by a fresher invocation, from
 * clobbering that fresher invocation's state when it finally finishes and calls release.
 */
export async function releaseJob(
  client: ServiceClient,
  name: string,
  claimedStartedAt: string,
  outcome: { completedAt: Date; error?: string | null },
): Promise<SchedulerResult<ScheduledJobRow>> {
  const { data, error } = await client
    .from("scheduled_job")
    .update({
      status: "idle",
      last_fired_at: claimedStartedAt,
      last_completed_at: outcome.completedAt.toISOString(),
      last_error: outcome.error ?? null,
    })
    .eq("name", name)
    .eq("started_at", claimedStartedAt)
    .select()
    .maybeSingle();

  if (error) return databaseError(error);
  if (!data) {
    return fail("job_already_running", `job "${name}"'s claim was already reclaimed by another invocation`);
  }
  return { ok: true, data };
}
