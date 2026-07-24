// Shared entity and DTO types. Table/enum shapes are derived from the generated
// `Database` type so they follow the migrations automatically.
import type { Database } from "@/db/database.types";

/** A weekly digest run — the durable state the multi-day pipeline resumes on. */
export type DigestRun = Database["public"]["Tables"]["digest"]["Row"];

/** States of the digest state machine; mirrors the `digest_status` Postgres enum. */
export type DigestStatus = Database["public"]["Enums"]["digest_status"];

/** Pipeline stages that record a completion checkpoint on `digest`. */
export type DigestStage = "collection" | "ranking" | "translation";

/** The ISO week a digest covers, as `YYYY-MM-DD` date strings. */
export interface DigestWindow {
  start: string;
  end: string;
}

/**
 * Why a run-state operation failed. Every reason is expected and handled by callers —
 * these are results, not exceptions.
 *
 * - `not_configured` — no service-role key is set, so domain tables are unreachable
 * - `active_digest_exists` — the partial unique index rejected a second live digest for the week
 * - `illegal_transition` — the transition is not in the state machine (app guard or DB trigger)
 * - `concurrent_modification` — the row's status changed between read and write
 * - `not_found` — no digest with that id
 * - `database_error` — anything else Postgres reported
 */
export type RunStateErrorReason =
  | "not_configured"
  | "active_digest_exists"
  | "illegal_transition"
  | "concurrent_modification"
  | "not_found"
  | "database_error";

export interface RunStateError {
  ok: false;
  reason: RunStateErrorReason;
  message: string;
}

export type RunStateResult<T> = { ok: true; data: T } | RunStateError;
