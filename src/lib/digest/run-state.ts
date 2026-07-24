// SERVER-ONLY. Every function here reaches the domain tables with a service-role client,
// which bypasses row-level security. Never import this module from a React island or any
// client-reachable path.
//
// RUNTIME-NEUTRAL BY DESIGN: the client is injected rather than constructed here, so this
// module resolves in the Astro runtime, in Vitest, and in the plain Node worker alike.
// Do not import astro:env/server (directly or via src/lib/supabase-admin.ts) from this
// file — that virtual module only exists inside Astro's build and would break the worker.
// Astro callers pass `createServiceClient()` from src/lib/supabase-admin.ts; the worker
// passes one built from src/worker/env.ts.
//
// This is the run-state contract downstream slices call (S-01 collection, S-02 ranking,
// S-03 shortlist). All state lives in Postgres: the pipeline spans days and the worker
// resumes by reading the digest's status + checkpoints on boot, never from memory.
//
// After any migration touching digest/article/cluster, regenerate the types:
//   npx supabase gen types typescript --project-id <ref> > src/db/database.types.ts
import type { PostgrestError } from "@supabase/supabase-js";

import type { Database } from "@/db/database.types";
import { canTransition, TERMINAL_STATES } from "@/lib/digest/state-machine";
import type { ServiceClient } from "@/lib/supabase-service";
import type { DigestRun, DigestStage, DigestStatus, DigestWindow, RunStateError, RunStateResult } from "@/types";

type DigestUpdate = Database["public"]["Tables"]["digest"]["Update"];

/** Postgres unique violation — raised by `one_active_digest_per_week`. */
const UNIQUE_VIOLATION = "23505";
/** Postgres check violation — the errcode the transition-guard trigger raises with. */
const CHECK_VIOLATION = "23514";
/** PostgREST: `.single()` matched no row. */
const NO_ROWS_RETURNED = "PGRST116";

/** Builds the checkpoint patch for a stage. Written out per stage to stay type-checked. */
const STAGE_CHECKPOINT: Record<DigestStage, (at: string) => DigestUpdate> = {
  collection: (at) => ({ collection_completed_at: at }),
  ranking: (at) => ({ ranking_completed_at: at }),
  translation: (at) => ({ translation_completed_at: at }),
};

function fail(reason: RunStateError["reason"], message: string): RunStateError {
  return { ok: false, reason, message };
}

function databaseError(error: PostgrestError): RunStateError {
  return fail("database_error", `${error.code}: ${error.message}`);
}

/**
 * Insert a new digest for the given week, in `collecting`.
 *
 * A second live digest for the same week is rejected by the partial unique index and
 * surfaces as `active_digest_exists` — the expected outcome when the Sunday schedule
 * collides with a manual re-trigger.
 */
export async function createDigest(client: ServiceClient, window: DigestWindow): Promise<RunStateResult<DigestRun>> {
  const { data, error } = await client
    .from("digest")
    .insert({ window_start: window.start, window_end: window.end })
    .select()
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return fail("active_digest_exists", `an active digest already exists for the week starting ${window.start}`);
    }
    return databaseError(error);
  }
  return { ok: true, data };
}

/**
 * Move a digest to `to`, guarding against illegal moves twice: app-side via the
 * transition map, and at the database via the trigger (authoritative). The update is
 * scoped to the status we read, so a concurrent writer surfaces as
 * `concurrent_modification` instead of silently overwriting.
 *
 * `last_error` is written only when the caller supplies one — passing `null` clears it
 * explicitly — and is cleared automatically when a failed run is re-triggered. An
 * unannotated transition leaves the column alone, so it cannot silently erase the
 * diagnostic a previous caller recorded.
 */
export async function transitionDigest(
  client: ServiceClient,
  id: string,
  to: DigestStatus,
  options: { lastError?: string | null } = {},
): Promise<RunStateResult<DigestRun>> {
  const current = await resumeDigest(client, id);
  if (!current.ok) return current;

  const from = current.data.status;
  if (!canTransition(from, to)) {
    return fail("illegal_transition", `illegal digest transition: ${from} -> ${to}`);
  }

  const patch: DigestUpdate = { status: to };
  if (options.lastError !== undefined) {
    patch.last_error = options.lastError;
  } else if (from === "failed") {
    // Re-triggering a failed run starts a clean slate (FR-018).
    patch.last_error = null;
  }

  const { data, error } = await client.from("digest").update(patch).eq("id", id).eq("status", from).select().single();

  if (error) {
    if (error.code === CHECK_VIOLATION) return fail("illegal_transition", error.message);
    if (error.code === NO_ROWS_RETURNED) {
      return fail("concurrent_modification", `digest ${id} is no longer in status ${from}`);
    }
    return databaseError(error);
  }
  return { ok: true, data };
}

/**
 * Stamp a stage's checkpoint timestamp. The status is untouched, so the transition guard
 * passes this through — checkpoints are how a restarted worker knows what it can skip.
 */
export async function markStageComplete(
  client: ServiceClient,
  id: string,
  stage: DigestStage,
  completedAt: Date = new Date(),
): Promise<RunStateResult<DigestRun>> {
  const { data, error } = await client
    .from("digest")
    .update(STAGE_CHECKPOINT[stage](completedAt.toISOString()))
    .eq("id", id)
    .select()
    .single();

  if (error) {
    if (error.code === NO_ROWS_RETURNED) return fail("not_found", `no digest with id ${id}`);
    return databaseError(error);
  }
  return { ok: true, data };
}

/**
 * The live (non-terminal) digest for a week, or `null` when the week is free. The
 * scheduler calls this before creating a run.
 */
export async function getActiveDigestForWeek(
  client: ServiceClient,
  window: Pick<DigestWindow, "start">,
): Promise<RunStateResult<DigestRun | null>> {
  const { data, error } = await client
    .from("digest")
    .select("*")
    .eq("window_start", window.start)
    .not("status", "in", `(${TERMINAL_STATES.join(",")})`)
    .maybeSingle();

  if (error) return databaseError(error);
  return { ok: true, data };
}

/**
 * Read a digest's full persisted state — status, checkpoints, cost, last error. This is
 * the worker's boot path: everything needed to resume comes from this one row.
 */
export async function resumeDigest(client: ServiceClient, id: string): Promise<RunStateResult<DigestRun>> {
  const { data, error } = await client.from("digest").select("*").eq("id", id).maybeSingle();

  if (error) return databaseError(error);
  if (!data) return fail("not_found", `no digest with id ${id}`);
  return { ok: true, data };
}
