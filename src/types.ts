// Shared entity and DTO types. Table/enum shapes are derived from the generated
// `Database` type so they follow the migrations automatically.
import type { Database } from "@/db/database.types";

/** A weekly digest run — the durable state the multi-day pipeline resumes on. */
export type DigestRun = Database["public"]["Tables"]["digest"]["Row"];

/** States of the digest state machine; mirrors the `digest_status` Postgres enum. */
export type DigestStatus = Database["public"]["Enums"]["digest_status"];

/** Pipeline stages that record a completion checkpoint on `digest`. */
export type DigestStage = "collection" | "ranking" | "translation" | "generation" | "rendering";

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
 * - `storage_error` — Supabase Storage refused a read or write (S-06 stores rendered images)
 * - `database_error` — anything else Postgres reported
 */
export type RunStateErrorReason =
  | "active_digest_exists"
  | "illegal_transition"
  | "concurrent_modification"
  | "not_found"
  | "storage_error"
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

/**
 * One shortlisted story as the dashboard renders it — a view DTO assembled from a cluster and
 * its representative article, shared by the Astro page and the React card so the selectable and
 * read-only renderings cannot drift apart.
 */
export interface ShortlistItem {
  clusterId: string;
  rank: number;
  tier: string | null;
  /** The rubric's 0-100 relevance score. Null alongside `tier` for a pre-S-09 cluster. */
  score: number | null;
  /** The rubric's one-line editorial reasoning (S-09 archive view). */
  rationale: string | null;
  coverageCount: number;
  /** Null until the translation stage has run over this cluster's representative. */
  polishTitle: string | null;
  polishSummary: string | null;
  /** FR-009a: always present, and always rendered — as the second language when a translation
   * exists, as the only one when it does not. */
  originalTitle: string;
  originalLede: string | null;
  originalLanguage: string | null;
  sourceUrl: string | null;
  translated: boolean;
}

/** A confirmed story selection — the operator's choice for one digest (S-04, FR-012). */
export type SelectionRow = Database["public"]["Tables"]["selection"]["Row"];

/** One shortlisted cluster's label: picked or passed (US-10). */
export type SelectionItemRow = Database["public"]["Tables"]["selection_item"]["Row"];

/** FR-012's output format; mirrors the `selection_format` Postgres enum. */
export type SelectionFormat = Database["public"]["Enums"]["selection_format"];

/** FR-012's target platforms; mirrors the `selection_platform` Postgres enum. */
export type SelectionPlatform = Database["public"]["Enums"]["selection_platform"];

/**
 * Why confirming a selection did not succeed. Mirrors {@link RunStateErrorReason}: these are
 * expected results the caller handles, not exceptions. Each maps from a SQLSTATE raised by
 * `confirm_selection` (see the migration's header) except the first two, which the API route
 * decides before reaching the database.
 *
 * - `unauthorized` — no operator session; the route answers 401 rather than redirecting
 * - `invalid_request` — malformed body, or a pick set the rules reject (SG003, SG004)
 * - `wrong_status` — the digest is not in `ready_for_selection` (SG002)
 * - `stale_shortlist` — the shortlist sent no longer matches the digest's ranked clusters (SG005)
 * - `already_confirmed` — a selection for this digest exists (23505 on selection.digest_id)
 * - `not_found` — no digest with that id (SG001)
 * - `not_configured` — no Supabase service client
 * - `database_error` — anything else Postgres reported
 */
export type SelectionErrorReason =
  | "unauthorized"
  | "invalid_request"
  | "wrong_status"
  | "stale_shortlist"
  | "already_confirmed"
  | "not_found"
  | "not_configured"
  | "database_error";

export interface SelectionError {
  ok: false;
  reason: SelectionErrorReason;
  message: string;
}

export type SelectionResult<T> = { ok: true; data: T } | SelectionError;

/** One Polish social adaptation of a selected story (S-05, FR-013). */
export type GeneratedCopyRow = Database["public"]["Tables"]["generated_copy"]["Row"];

/**
 * One pulled-out figure from a story — FR-013's "key statistics". Stored as a jsonb array on
 * `generated_copy.key_statistics`; the column is typed `Json`, so this is the shape the
 * generation schema validates and every reader should parse back into.
 */
export interface KeyStatistic {
  /** What the figure measures, in Polish — e.g. "Wzrost cen w Barcelonie". */
  label: string;
  /** The figure as it should be rendered — e.g. "8,3%". Kept as text: it is display copy. */
  value: string;
}

/**
 * Which source material a generated adaptation rests on.
 *
 * - `article` — the story's page was fetched and its body extracted
 * - `lede` — that failed (blocked source, paywall, unparseable layout) and generation fell back
 *   to the stored title + lede, so the copy is thinner and the numeric gate saw fewer figures
 */
export type SourceTextOrigin = "article" | "lede";

/**
 * One rendered image for a published slide (S-06, FR-015).
 *
 * The unit is a slide, not a story: a carousel's cover slide belongs to the digest as a whole,
 * which is why `cluster_id` is nullable. `storage_path` addresses an object in the private
 * `digest-assets` bucket — never a URL, because the Slides export URLs it came from expire.
 */
export type GeneratedAssetRow = Database["public"]["Tables"]["generated_asset"]["Row"];

/**
 * Why a visual could not be built from a story's copy (S-06, FR-015). Mirrors
 * {@link SelectionErrorReason}: these are expected results the render stage handles and turns
 * into a `failed` digest with a diagnostic, not exceptions.
 *
 * - `malformed_statistics` — `generated_copy.key_statistics` is not an array of `{label, value}`
 * - `insufficient_statistics` — fewer usable figures than the template has fixed stat slots
 * - `empty_title` — the story's Polish title is blank, so the card would render headline-less
 * - `title_too_long` — the headline is past the last fit tier; no font size renders it whole
 */
export type VisualErrorReason = "malformed_statistics" | "insufficient_statistics" | "empty_title" | "title_too_long";

export interface VisualError {
  ok: false;
  reason: VisualErrorReason;
  message: string;
}

export type VisualResult<T> = { ok: true; data: T } | VisualError;

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

/** The operator's approve-or-reject decision for one digest, with an optional note (S-07, FR-020). */
export type ApprovalRow = Database["public"]["Tables"]["approval"]["Row"];

/** FR-020's two outcomes; mirrors the `approval_decision` Postgres enum. */
export type ApprovalDecision = Database["public"]["Enums"]["approval_decision"];

/**
 * Why recording a decision did not succeed. Mirrors {@link SelectionErrorReason}: these are
 * expected results the caller handles, not exceptions. Each maps from a SQLSTATE raised by
 * `record_approval` (see the migration's header) except the first two, which the API route
 * decides before reaching the database.
 *
 * - `unauthorized` — no operator session; the route answers 401 rather than redirecting
 * - `invalid_request` — malformed body, or a note the rules reject (AG003)
 * - `wrong_status` — the digest is not in `ready_for_approval` (AG002)
 * - `already_decided` — a decision for this digest exists (23505 on approval.digest_id)
 * - `not_found` — no digest with that id (AG001)
 * - `not_configured` — no Supabase service client
 * - `database_error` — anything else Postgres reported
 */
export type ApprovalErrorReason =
  | "unauthorized"
  | "invalid_request"
  | "wrong_status"
  | "already_decided"
  | "not_found"
  | "not_configured"
  | "database_error";

export interface ApprovalError {
  ok: false;
  reason: ApprovalErrorReason;
  message: string;
}

export type ApprovalResult<T> = { ok: true; data: T } | ApprovalError;

/**
 * One picked story's complete adaptation, shaped for the S-07 approval page — a join of
 * `generated_copy` (the Polish adaptation) and the representative `article` (the original, for
 * fact-checking beside it). Built by the page, rendered by `GeneratedStoryCard.astro`. Lives here
 * rather than in the component file: `ShortlistItem` sets the precedent that a domain-shaped view
 * model dot-accessed across files belongs in `src/types.ts`, not in an `.astro` file's own export
 * — the type-aware linter cannot fully resolve member access on an interface imported from a
 * `.astro` file, even though `tsc`/`astro check` handle it correctly.
 */
export interface ApprovalStory {
  clusterId: string;
  polishTitle: string;
  captionSummary: string;
  bodyCopy: string;
  keyStatistics: KeyStatistic[];
  sourceTextOrigin: SourceTextOrigin;
  /** Null when the source article row could not be found — shown, not hidden, as a gap. */
  originalTitle: string | null;
  originalLede: string | null;
  sourceUrl: string | null;
  language: string | null;
}

/** One platform's recorded publish outcome for a digest (S-08, FR-022, US-20). */
export type PublicationRow = Database["public"]["Tables"]["publication"]["Row"];

/** `record_publication`'s two outcomes; mirrors the `publication_status` Postgres enum. */
export type PublicationStatus = Database["public"]["Enums"]["publication_status"];

/**
 * Why publishing did not succeed for a digest (not per-platform — a per-platform failure is a
 * `PublishOutcome`, not a `PublicationError`; this is the orchestrator/route-level failure that
 * stops the whole run before any platform is attempted). Mirrors {@link ApprovalErrorReason}: these
 * are expected results the caller handles, not exceptions. Each maps from a SQLSTATE raised by
 * `record_publication` (see the migration's header) except the first two, which the API route
 * decides before reaching the database.
 *
 * - `unauthorized` — no operator session; the route answers 401 rather than redirecting
 * - `invalid_request` — malformed body
 * - `wrong_status` — the digest is not `approved`/`skipped`/`published` (PB002)
 * - `not_found` — no digest with that id (PB001)
 * - `not_configured` — no Supabase service client
 * - `database_error` — anything else Postgres reported
 */
export type PublicationErrorReason =
  | "unauthorized"
  | "invalid_request"
  | "wrong_status"
  | "not_found"
  | "not_configured"
  | "database_error";

export interface PublicationError {
  ok: false;
  reason: PublicationErrorReason;
  message: string;
}

export type PublicationResult<T> = { ok: true; data: T } | PublicationError;

/** One platform's outcome from a single `runPublish` call (S-08, US-20). */
export type PublishOutcome =
  | { platform: SelectionPlatform; ok: true; postId: string }
  | { platform: SelectionPlatform; ok: false; error: string };

/** Every platform attempted by one `runPublish` call, in the order they were attempted. */
export type PublishSummary = PublishOutcome[];
