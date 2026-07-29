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
 * - `active_digest_exists` — the partial unique index rejected a second live digest for the week
 * - `illegal_transition` — the transition is not in the state machine (app guard or DB trigger)
 * - `concurrent_modification` — the row's status changed between read and write
 * - `not_found` — no digest with that id
 * - `database_error` — anything else Postgres reported
 */
export type RunStateErrorReason =
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

/**
 * Why an LLM invocation did not return usable output. Mirrors {@link RunStateErrorReason}: these
 * are expected results the caller handles, not exceptions.
 *
 * - `ceiling_reached` — the digest is already at/over its spend ceiling; no call was made
 * - `malformed_output` — a schema-constrained response failed validation twice (F-03 Phase 3)
 * - `refusal` — the model declined (HTTP 200, `stop_reason: "refusal"`)
 * - `truncated` — the response hit `max_tokens`
 * - `context_exceeded` — the prompt exceeded the model's context window
 * - `api_error` — a transport failure, an unexpected stop reason, or a post-call accounting failure
 * - `not_configured` — no LLM client (missing `ANTHROPIC_API_KEY`)
 */
export type LlmErrorReason =
  | "ceiling_reached"
  | "malformed_output"
  | "refusal"
  | "truncated"
  | "context_exceeded"
  | "api_error"
  | "not_configured";

export interface LlmError {
  ok: false;
  reason: LlmErrorReason;
  message: string;
}

export type LlmResult<T> = { ok: true; data: T } | LlmError;

/**
 * Why an email notification did not send. Mirrors {@link LlmErrorReason}: these are expected
 * results the caller handles, not exceptions.
 *
 * - `not_configured` — no email client (missing Gmail credentials) or no recipient address
 * - `invalid_recipient` — the recipient address failed a basic email-shape check
 * - `send_failed` — the transport rejected the send (auth failure, network error, provider error)
 */
export type EmailErrorReason = "not_configured" | "invalid_recipient" | "send_failed";

export interface EmailError {
  ok: false;
  reason: EmailErrorReason;
  message: string;
}

export type EmailResult = { ok: true } | EmailError;

/** A named job's scheduling state — is it running, when did it last fire/complete. */
export type ScheduledJobRow = Database["public"]["Tables"]["scheduled_job"]["Row"];

/**
 * Why a scheduler-store operation did not produce the requested outcome. Mirrors
 * {@link RunStateErrorReason}: these are expected results the caller handles, not exceptions.
 *
 * - `job_already_running` — another invocation genuinely holds the job's lock (not stale)
 * - `database_error` — anything else Postgres reported
 */
export type SchedulerErrorReason = "job_already_running" | "database_error";

export interface SchedulerError {
  ok: false;
  reason: SchedulerErrorReason;
  message: string;
}

export type SchedulerResult<T> = { ok: true; data: T } | SchedulerError;
