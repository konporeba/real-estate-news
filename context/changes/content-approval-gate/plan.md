# Content Approval Gate (S-07) Implementation Plan

## Overview

Roadmap slice **S-07** (FR-019, FR-020, FR-021, US-16, US-17) — the second and last human gate. When
the rendering stage finishes, the operator is emailed that content is ready; a dedicated approval
page shows the complete generated post — Polish copy, key statistics beside their source, and the
rendered cards — and the operator approves it or rejects it with a note. Nothing publishes without
an explicit approve, in every path. A Monday 09:00 `Europe/Warsaw` reminder names whichever human
gate is still outstanding.

## Current State Analysis

The pipeline runs end to end as far as `ready_for_approval` and then stops: `renderDigest` performs
the last automatic transition (`src/lib/visuals/render.ts:518`) and nothing reads the result. The
digest sits there indefinitely — which is correct behaviour, but the operator is never told, has no
way to see the generated copy, and has no control that moves the digest forward.

Concretely, what exists and what does not:

- **`generated_copy` has never been read by the app.** The table was written for this gate — its own
  column comment says "S-07 renders them at the approval gate"
  (`supabase/migrations/20260906150000_generated_copy.sql:38-41,66`) — but no query against it exists
  under `src/pages/`.
- **`generated_asset` is already rendered on the digest page**, with the error / partial / not-yet-run
  distinction intact (`src/pages/dashboard/[id].astro:164-247`).
- **The approve transition is already legal**; the reject one does not exist. `ready_for_approval →
approved | skipped | failed` is in both the TS map (`src/lib/digest/state-machine.ts:20`) and the
  trigger (`supabase/migrations/20260908140000_visual_assets.sql:53`). There is no `rejected`.
- **No decision is persisted anywhere.** There is no table, column or timestamp recording that a
  human said yes.
- **The scheduler has exactly one job** (`collection`, Sunday 17:00) and takes a second as pure data.
- **F-04's email harness has never sent an approval email**; FR-019 and FR-021 were deferred to this
  slice by name (`context/changes/outbound-email-notifications/plan.md:5,26`).

### Key Discoveries:

- **`ready_for_approval → approved` needs no migration** (`src/lib/digest/state-machine.ts:20`), but
  `rejected` needs one that reproduces the _entire_ `enforce_digest_transition` body — the drift
  guard resolves the trigger from the **latest** migration containing it
  (`src/lib/digest/state-machine.test.ts:15-26,50-53`).
- **`one_active_digest_per_week` has not been redefined since F-01**
  (`supabase/migrations/20260722173032_digest_core_schema.sql:52-54`). Because `rejected` is terminal,
  this plan's migration must redefine it — and the guard resolves that index by the predicate string
  `where status not in (`, so the redefinition must be real SQL, not a comment
  (`state-machine.test.ts:41-45,52`).
- **`alter type ... add value` must be alone in its migration.** Postgres refuses to let a new enum
  value be _used_ in the same transaction that added it — S-06 hit this and split the files
  (`supabase/migrations/20260908130000_rendering_status_enum.sql:1-17`).
- **`confirm_selection` is the RPC template** — `security definer`, `set search_path = public`,
  `select status ... for update` to serialise concurrent writers, and a distinct SQLSTATE per
  rejection, verified to survive PostgREST into `error.code`
  (`supabase/migrations/20260829120000_selection_gate.sql:93-183`;
  `context/archive/2026-08-01-story-selection-gate/change.md:12-15`).
- **The API route must 401 before reading the body** — `PROTECTED_ROUTES` covers only `/dashboard`
  and answers with a 302 a `fetch()` would follow and fail to parse
  (`src/middleware.ts:7-16`, `src/pages/api/selection/confirm.ts:63-70`).
- **The runtime boundary splits this slice in half**: a `src/pages/` route may not import
  `@/lib/email/*` or `@/lib/scheduler/*` (`eslint.config.js:74-97`), so the email is worker-side, the
  route is app-side, and they share only the database and `src/lib/digest/`.
- **`npx supabase db push` and `gen types` are both unusable on this project.** Migrations are applied
  by hand through the SQL Editor and types are hand-edited into `src/db/database.types.ts:1-35`. The
  `migration repair` debt stands at eight versions.
- **There is no test infrastructure for pages or components** — Vitest collects `src/**/*.test.ts`
  only, no DOM environment (`vitest.config.ts:18`). Route and UI behaviour is verified by a
  lib-level integration suite plus manual steps.

## Desired End State

`npm run visuals` finishes and the operator receives an email listing the week's generated stories
with a button to the approval page. The page shows, per story, the Polish title, caption summary,
body copy and key statistics — the statistics beside the original title/lede and a link to the source
article — plus the rendered cards and the `source_text_origin` flag. Approve opens a summary of
exactly what will publish and where, and confirming moves the digest to `approved`. Reject, with an
optional note, moves it to `rejected`, from which `npm run generate` can produce fresh copy on the
same confirmed selection. Every Monday at 09:00 `Europe/Warsaw`, a digest still sitting at either
human gate produces one email naming the outstanding step; a clear week produces silence.

**Verified by**: a real digest driven `rendering → ready_for_approval → approved` through the UI
with the operator confirming the post is publishable, plus a rejection exercised on a second digest
and recovered through `npm run generate`.

## What We're NOT Doing

- **No publishing.** S-08 owns Tuesday 17:00, per-platform results, and FR-023's missed-deadline
  behaviour. This slice only produces the `approved` state that S-08 will consume.
- **No `publication` table, no platform write-back.** S-08's schema.
- **No archive browsing or rubric feedback.** FR-024/FR-025 are S-09; this slice only _stores_ the
  decision and its note so S-09 has something to learn from.
- **No heartbeat or dead-man's-switch.** The Monday reminder is silent when nothing is outstanding;
  detecting that the reminder _itself_ stopped running is S-10 (FR-028).
- **No second notification channel.** Roadmap OQ#6 closes as "no" — email only.
- **No operator control for `skipped`.** `ready_for_approval → skipped` stays legal for US-19, but
  the only UI controls this slice adds are approve and reject.
- **No editing of generated copy.** The gate is approve-or-reject; fixing copy means rejecting and
  regenerating.
- **No backfill.** Digests already sitting in `ready_for_approval` predate the rendering stage and
  have no assets (`context/archive/2026-09-08-brand-visual-assets/plan.md:626`); the approval page
  shows an empty card strip for them, exactly as the digest page does.
- **No clearing of the `supabase migration repair` debt** unless the connection problem has resolved
  itself — but Phase 1 must re-record it explicitly rather than skip it silently.

## Implementation Approach

Bottom-up, in the order the repo already uses for a gate: state machine → database function →
HTTP contract → UI → notifications → live verification. The state and the write path land first
because everything else is a consumer, and because the migration touches the most heavily
drift-guarded surface in the codebase — better to have that failing loudly on its own than tangled
with UI work.

The two notification phases come after the UI deliberately: FR-019's email links to the approval
page, so building the page first means the CTA can be verified against something real rather than a
route that does not exist yet.

## Critical Implementation Details

**Migration ordering is a hard Postgres constraint, not a style choice.** `alter type digest_status
add value 'rejected'` must be alone in its own migration file, because Postgres refuses to let a
value added by `alter type` be _used_ by any other statement in the same transaction, and Supabase
applies each file in its own transaction. The trigger redefinition that references `'rejected'`
therefore belongs in a second, later file. S-06's `20260908130000_rendering_status_enum.sql:1-17`
records this in full and its header warns that adding "so much as a comment-free DDL statement that
mentions `rendering`" reintroduces the error.

**Two drift guards will fail until both sides move together.**
`src/lib/digest/state-machine.test.ts` resolves the trigger from the latest migration containing
`enforce_digest_transition` and the index predicate from the latest containing `where status not in`,
then asserts full parity with `TRANSITIONS` and `TERMINAL_STATES` projected over
`Constants.public.Enums.digest_status`. Since `Constants` is hand-maintained here, adding `rejected`
means editing the migration, the TS map, `TERMINAL_STATES`, and `database.types.ts` in one change.

**`approved` is a one-way door for the operator.** Its only exits are `published`, `skipped` and
`failed` — there is no un-approve. This is what the two-step review control exists for.

---

## Phase 1: The `rejected` state

### Overview

Add `rejected` to the digest state machine as a terminal state that is not publishable, recoverable
into `generating`. Two migrations, the TypeScript mirror, and the hand-maintained types — all four
in lockstep, proven by the existing drift guard.

### Changes Required:

#### 1. The enum value, alone

**File**: `supabase/migrations/<ts>_rejected_status_enum.sql`

**Intent**: Add `rejected` to `digest_status` in its own file so nothing in the same transaction
references it. Position it after `approved` so the enum still reads in pipeline order.

**Contract**: `alter type digest_status add value 'rejected' after 'approved';` — and nothing else in
the file, per the warning in `20260908130000_rendering_status_enum.sql:15-16`.

#### 2. The transition trigger and the week index

**File**: `supabase/migrations/20260912093000_approval_gate.sql`

**Intent**: Redefine `enforce_digest_transition()` to allow `ready_for_approval → rejected` and
`rejected → generating`, and redefine `one_active_digest_per_week` so a rejected week no longer
occupies its slot and can be re-collected.

**Contract**: `create or replace function enforce_digest_transition()` reproducing the whole body
from `20260908140000_visual_assets.sql:36-68` with two clauses added; then
`drop index one_active_digest_per_week;` and a recreate whose predicate is
`where status not in ('published', 'skipped', 'failed', 'rejected')`. The predicate must be real SQL
— `state-machine.test.ts:41-45` finds this index by searching migrations for the literal
`where status not in (`, and picks the latest file containing it.

#### 3. The TypeScript mirror

**File**: `src/lib/digest/state-machine.ts`

**Intent**: Add `rejected: ["generating"]` to `TRANSITIONS`, add `rejected` to
`ready_for_approval`'s target list, and add it to `TERMINAL_STATES`. Comment why it is not `skipped`:
`skipped → published` exists for US-19's missed deadline, and a rejected digest must never be
publishable.

**Contract**: `TRANSITIONS` and `TERMINAL_STATES` must satisfy `state-machine.test.ts`'s parity
assertions against the parsed SQL and against `Constants.public.Enums.digest_status`.

#### 4. The hand-maintained types

**File**: `src/db/database.types.ts`

**Intent**: Add `"rejected"` to the `digest_status` union and to
`Constants.public.Enums.digest_status`, and add a line to the header's EXCEPTION ledger naming this
migration — `gen types` cannot be run on this project (`:8-11`).

**Contract**: The union at `:531-541` and the `Constants` array must both carry the new member, or
the drift guard's "covers every digest_status value" assertion fails.

#### 5. Recovery into the generation stage

**File**: `src/worker/generate.ts`

**Intent**: Make the `rejected → generating` edge actually reachable from the CLI. Without this the
state machine permits the move but nothing performs it, and `npm run generate` refuses a rejected
digest outright — the recovery the whole reject decision rests on would not exist.

**Contract**: Extend `resolveTargetDigest`'s explicit-`--digest` exception (`:78-100`) to accept
`rejected` alongside `failed`, reusing the existing `hasConfirmedSelection` guard — a rejected digest
always has one, since it got through generation to reach the gate. Keep the rule that the retry is
**never implicit**: the no-flag default still only picks up digests already in `generating`. Update
the function's docstring, which currently states the exception is for `failed` alone.

Note for the implementer: re-activating a terminal digest can collide with
`one_active_digest_per_week` if another digest is live for the same week. `transitionDigest` maps
`CHECK_VIOLATION` and `NO_ROWS_RETURNED` but not `23505`
(`src/lib/digest/run-state.ts:107-112`), so that collision surfaces as a generic `database_error`
rather than "a digest already exists for this week". This is pre-existing behaviour on the
`failed → collecting` edge and is **not** in scope to fix here — it is recorded so it is not
debugged from scratch.

### Success Criteria:

#### Automated Verification:

- State-machine drift guard passes: `npx vitest run src/lib/digest/state-machine.test.ts`
- Generation entrypoint tests pass: `npx vitest run src/worker/generate.test.ts`
- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- Full suite passes: `npm test`

#### Manual Verification:

- Both migrations applied to the Supabase project through the SQL Editor, and the eight-version
  `supabase migration repair` debt inherited from F-01/S-05/S-06 is either cleared or explicitly
  re-recorded in this plan's Migration Notes as still outstanding
- Against the live project, bypassing the TypeScript guard: `ready_for_approval → rejected` and
  `rejected → generating` are accepted, and `rejected → published` and `rejected → approved` are
  rejected with errcode 23514
- `select indexdef from pg_indexes where indexname = 'one_active_digest_per_week'` shows `rejected`
  in the predicate
- `npm run generate -- --digest=<a rejected digest>` accepts it and moves it back to `generating`,
  while the no-flag default still ignores rejected digests

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation before proceeding.

---

## Phase 2: Approval record and the `record_approval` RPC

### Overview

Persist the operator's decision and perform the transition in one transaction, mirroring
`confirm_selection`. This is the authoritative gate; everything above it is affordance.

### Changes Required:

> **Deviation from the original plan, decided during implementation (2026-09-12):** Phase 1's
> migration (`20260912093000_approval_gate.sql`) is already applied to the live project and
> recorded in `supabase_migrations.schema_migrations` — its manual verification required the
> trigger/index changes to be live before Phase 1's integration tests could pass. `supabase
migration repair`/`db push` track applied state by file **version**, not content checksum, so
> appending new SQL to an already-applied file risks a future `db push` treating that version as
> already handled and silently skipping the new statements. The approval table and RPC below
> therefore land in their own new file, `20260912100000_approval_record.sql`, rather than the
> file Phase 1 used.

#### 1. The `approval` table

**File**: `supabase/migrations/20260912100000_approval_record.sql`

**Intent**: One row per decision per digest, recording what was decided, optionally why, and when.
Deny-by-default RLS like every other table, so only the service-role client reaches it.

**Contract**: `approval (id uuid pk, digest_id uuid not null references digest on delete cascade
unique, decision approval_decision not null, note text, decided_at timestamptz not null default
now())`, a new `approval_decision` enum (`'approved' | 'rejected'`), a length check on `note`, an
index on `digest_id`, `alter table approval enable row level security` with no policies, and table
/ column comments in the house style. The `unique (digest_id)` is what makes a second decision a
loud `23505` rather than a silent overwrite — the same role it plays in `selection`.

Note the enum here is created with `create type`, not `alter type ... add value`, so it is safe in a
shared migration; only the `digest_status` addition needed its own file.

#### 2. `record_approval()`

**File**: same migration (`20260912100000_approval_record.sql`)

**Intent**: Validate that the digest exists and is awaiting approval, write the decision, and
transition to `approved` or `rejected` — all or nothing.

**Contract**: `record_approval(p_digest_id uuid, p_decision approval_decision, p_note text)
returns uuid`, `language plpgsql security definer set search_path = public`. Opens with
`select status into v_status from digest where id = p_digest_id for update` so a concurrent second
call blocks and then fails on status rather than racing. Raises `AG001` (not found), `AG002` (not in
`ready_for_approval`), `AG003` (note too long); a second decision surfaces as `23505` from the unique
constraint. The final `update digest set status = ...` passes through
`enforce_digest_transition`, so the trigger remains the last word even if this function's own check
were wrong — the same belt-and-braces `confirm_selection` relies on
(`context/archive/2026-08-01-story-selection-gate/plan.md:60`).

#### 3. Types for the new objects

**File**: `src/db/database.types.ts`

**Intent**: Hand-add `approval` under `public.Tables`, `approval_decision` under `public.Enums` and
in `Constants`, and `record_approval` under `public.Functions`; extend the header ledger.

**Contract**: `record_approval.Returns: string` — never null on success, since every failure path
raises. Same reasoning already written out for `confirm_selection` at `:526-528`.

#### 4. Shared domain types

**File**: `src/types.ts`

**Intent**: Derive `ApprovalRow` and `ApprovalDecision` from the generated `Database` type, and add
an `ApprovalErrorReason` union in the house `{ ok, reason, message }` idiom.

**Contract**: `ApprovalErrorReason = "invalid_request" | "wrong_status" | "already_decided" |
"not_found" | "unauthorized" | "not_configured" | "database_error"`, mirroring
`SelectionErrorReason`.

#### 5. Integration suite

**File**: `src/lib/approval/record.test.ts`

**Intent**: Exercise the RPC against the real project — the guarantee lives in the Postgres function,
not in TypeScript.

**Contract**: `describe.skipIf(!configured)` on the standard `SUPABASE_TEST_PROJECT=1` gate; claim
**synthetic year 3003** for week windows (3003+ is unused); the `beforeAll`/`afterAll` purge block
copied from `src/lib/digest/run-state.test.ts:68-87`. Follow `confirm.test.ts:5-9`'s standard —
**every rejection case asserts twice**: that the call failed with the expected SQLSTATE, _and_ that
the digest is still in `ready_for_approval` with no `approval` row behind it. Cover: approve happy
path; reject happy path with and without a note; wrong status; unknown digest; a second decision;
an over-long note.

### Success Criteria:

#### Automated Verification:

- Approval RPC suite passes: `SUPABASE_TEST_PROJECT=1 npx vitest run src/lib/approval/record.test.ts`
- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- Full suite passes: `npm test`

#### Manual Verification:

- The migration is applied through the SQL Editor and `approval` is reachable by the service role and
  denied to `anon`
- A digest approved through the RPC lands in `approved` with exactly one `approval` row; a rejected
  one lands in `rejected` with its note stored

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation before proceeding.

---

## Phase 3: Shared approval rules and the decide endpoint

### Overview

The HTTP contract. Almost no logic of its own: validation lives in a shared module the island also
imports, and the write is the single RPC from Phase 2.

### Changes Required:

#### 1. Shared rules

**File**: `src/lib/approval/rules.ts`

**Intent**: The single authority on what a valid decision request is, imported by both the route and
the island so the affordance and the enforcement cannot disagree. Plain `.ts`, not `.tsx`, because
Vitest cannot collect `.tsx` — the reason spelled out at `src/lib/selection/rules.ts:1-14`.

**Contract**: `APPROVAL_DECISIONS`, `DECISION_LABELS`, `MAX_NOTE_LENGTH`, and
`approvalRequestSchema` = `{ digestId: uuid, decision: enum, note?: string }` with the note trimmed
and length-checked. Mirrors `selectionRequestSchema`'s shape and its ordered-refinement style.

#### 2. Drift guard for the rules

**File**: `src/lib/approval/rules.test.ts`

**Intent**: Stop `MAX_NOTE_LENGTH` and the decision vocabulary drifting from the SQL that enforces
them.

**Contract**: Reuse the `readMigrations(marker, pick)` pattern from
`src/lib/selection/rules.test.ts:147-158` — `"latest"` for the replaceable function body, `"first"`
for the never-replaced `create type approval_decision`. Parse the note-length check out of
`record_approval` and the enum members out of the `create type`, and `throw` a named error on any
parse failure rather than passing silently.

#### 3. The endpoint

**File**: `src/pages/api/approval/decide.ts`

**Intent**: Authenticate, validate, call `record_approval`, and map SQLSTATEs onto typed JSON.

**Contract**: `export const prerender = false` and a `POST` handler. Order is load-bearing: 401 on
`!context.locals.operatorAuthenticated` **before** the body is read, because the middleware's
`PROTECTED_ROUTES` covers only `/dashboard` and answers with a 302 that `fetch()` would follow and
fail to parse (`src/pages/api/selection/confirm.ts:63-70`). Then zod (400), service client (503),
one RPC. A `Map` — not a `Record` — from SQLSTATE to `{ reason, status, message }`, so an unmapped
code is honestly typed `| undefined` and becomes a logged 500 carrying our wording, never Postgres's:
`AG001`→404 `not_found`, `AG002`→409 `wrong_status`, `AG003`→400 `invalid_request`, `23505`→409
`already_decided`.

### Success Criteria:

#### Automated Verification:

- Rules drift guard passes: `npx vitest run src/lib/approval/rules.test.ts`
- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- Full suite passes: `npm test`

#### Manual Verification:

- `POST /api/approval/decide` with no session cookie returns 401 JSON, not a redirect to `/auth/pin`
- A malformed body returns 400 with the specific field complaint; a decision on a digest not in
  `ready_for_approval` returns 409; a second decision on an already-decided digest returns 409 too
  — as `wrong_status`, not `already_decided`, because `record_approval`'s own status check fires
  before the digest can no longer be `ready_for_approval`, before the unique constraint on
  `approval.digest_id` is ever reached. This is not a bug: it is the exact behavior
  `confirm_selection` already has for S-04 (`confirm.test.ts`: "the status check fires first...
  the unique constraint... is the backstop underneath it"), so `already_decided` stays mapped for
  defense-in-depth but is not reachable under normal operation.
- No Postgres message text appears in any response body

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation before proceeding.

---

## Phase 4: The approval page and island

### Overview

The operator-facing gate: the complete generated post on one screen, with the fact-checking material
beside it, and a two-step approve plus a reject-with-note.

### Changes Required:

#### 1. The page

**File**: `src/pages/dashboard/[id]/approve.astro`

**Intent**: Load and render everything needed to decide: `generated_copy` per picked cluster, the
matching `generated_asset` images, and the source article behind each story. Show the decision
controls only while the digest is in `ready_for_approval`; show a read-only record of the decision
afterwards.

**Contract**: Four reads — `generated_copy` for the picked clusters, `generated_asset` for the
images, the representative `article` per cluster for the originals and source links, and
`selection` for `format` and `platforms` (which the island's approve summary names, and Progress 4.6
verifies). Reuses `createServiceClient()`, `ASSET_BUCKET` / `SIGNED_URL_TTL_SECONDS`, `AssetStrip`
and `OperatorHeader` exactly as `[id].astro` does, and signs all asset paths in **one**
`createSignedUrls` call. Every query failure must **return or guard**, never merely set a flag and
fall through — this is the repo's known footgun (S-04 impl-review; `astro/tsconfigs/strict` omits
`noUncheckedIndexedAccess`, so the index access below an unguarded error branch is invisible to the
compiler). Keep error, partial and empty distinct for both copy and assets, per S-03 impl-review F2.

Statuses: `ready_for_approval` renders the island; `approved` / `rejected` render the same post
read-only with a decision banner; anything earlier says the content is not generated yet; `failed`
shows `last_error`.

#### 2. Per-story presentation

**File**: `src/components/GeneratedStoryCard.astro`

**Intent**: One story's complete adaptation — Polish title, caption summary, body copy, and the key
statistics rendered _beside_ the original title/lede with a link to the source, so a suspect figure
can be traced without leaving the page. Show `source_text_origin` when it is `lede`, so a post that
reads short is explained.

**Contract**: Takes an already-shaped view model from the page (no querying of its own). The source
link must pass the same `isSafeUrl()` scheme check S-03's impl-review added — `source_url` is scraped
third-party content.

#### 3. The island and its hook

**Files**: `src/components/ApprovalPanel.tsx`, `src/components/hooks/useApproval.ts`

**Intent**: Hold the decision UI. Approve opens a summary of exactly what will publish and where —
story count, format and platforms, read from the confirmed `selection` — and only then offers the
confirm button; reject offers an optional note. Hydrated for the same reason `SelectionForm` is: the
transition is irreversible and unattended publishing follows it.

**Contract**: `useApproval(digestId)` exposes `decision`, `note`, `reviewing`, `submit` state and a
`confirm()` that POSTs to `/api/approval/decide`, in the discriminated-state shape of
`useSelection.ts:14-36` (`idle | submitting | error`), with a `network` reason for a fetch that never
produced a typed body. Validity comes from `@/lib/approval/rules` so a submit the island enables is
one the database will accept. On success, reload the page rather than mutating local state — the
post-decision view is server-rendered.

#### 4. Entry point from the digest page

**File**: `src/pages/dashboard/[id].astro`

**Intent**: When the digest is in `ready_for_approval`, link to the approval page; when it is
`approved` or `rejected`, say so. Minimal change — the review itself lives on its own route.

**Contract**: One banner plus link in the existing post-selection `Fragment`; no new queries, no new
error branch. **Also add `rejected` to `RENDERED_STATUSES` (`:20`)** — without it a rejected digest
fails that test and renders neither the asset strip nor its "No visuals rendered yet" fallback, so
the cards it really does have vanish with no explanation.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- Full suite passes: `npm test`

#### Manual Verification:

- On a real `ready_for_approval` digest the page shows every picked story's Polish title, caption,
  body and key statistics, with the original title/lede and a working source link beside them
- The rendered cards load behind the PIN gate; a digest with no assets shows an empty strip, not an
  error
- Approve requires the second confirmation step and the summary names the correct story count,
  format and platforms
- Reject with a note lands the digest in `rejected` and the note is stored
- After a decision the page is read-only and no control can re-decide
- A rejected digest's `/dashboard/[id]` page still shows its rendered cards, not a blank space
- Signing out and revisiting the URL redirects to `/auth/pin`

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation before proceeding.

---

## Phase 5: FR-019 — the approval-ready email

### Overview

Tell the operator the gate is open, the moment `npm run visuals` finishes.

### Changes Required:

#### 1. The builder

**File**: `src/lib/email/approval-ready.ts`

**Intent**: A pure function from the digest plus its generated copy to an `EmailRequest`, so the
mapping is testable without a transport. Body is the story list — Polish title, caption summary, a
`meta` line carrying the key-statistic count and a `lede`-origin marker where applicable — plus a CTA
to the approval page.

**Contract**: `buildApprovalReadyEmail(digest, stories, baseUrl?) → EmailRequest`, mirroring
`buildDigestReadyEmail`'s signature (`src/lib/email/digest-ready.ts:74`). Reuses
`renderArticleCards`; every interpolated string passes through `escapeHtml` first
(`src/lib/email/layout.ts:26-33,69`). CTA is `<baseUrl>/dashboard/<id>/approve`, omitted entirely
when no base URL is configured rather than emitted broken. **No image URLs**: the bucket is private
and signed URLs are short-lived, so nothing time-limited goes into a message that may be read days
later.

#### 2. Worker wiring

**File**: `src/worker/visuals.ts`

**Intent**: Send it at the entrypoint after the rendered-asset summary, never inside `renderDigest`.

**Contract**: `notifyApprovalReady(client, transport, digest, options)` following
`notifyDigestReady` (`src/worker/rank.ts:216-250`) exactly: every failure path **returns rather than
throws**, `not_configured` logs at info level, anything else logs an error, and `main()` still
returns 0. The digest is already in `ready_for_approval` and persisted by this point — a missing
Gmail credential must never turn a good render into a failed run.

#### 3. Tests

**Files**: `src/lib/email/approval-ready.test.ts`, `src/worker/visuals.test.ts`

**Intent**: Test the builder as a pure function on `bodyHtml` substrings, and the worker hook for the
one property that matters: it cannot fail the run.

**Contract**: Builder tests follow `digest-ready.test.ts` — subject, singular/plural, CTA URL with
trailing-slash normalisation, CTA absent without a base URL, HTML-escaping of Polish text. Worker
tests follow `rank.test.ts:136-200` using `fakeEmailTransport`: a null transport resolves
undefined, and a rejecting transport does not throw.

### Success Criteria:

#### Automated Verification:

- Builder tests pass: `npx vitest run src/lib/email/approval-ready.test.ts`
- Worker notify tests pass: `npx vitest run src/worker/visuals.test.ts`
- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- Full suite passes: `npm test`

#### Manual Verification:

- With Gmail credentials unset, `npm run visuals` completes normally and logs that email is not
  configured
- With credentials set, a real run delivers the email and its CTA opens the approval page for the
  right digest

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation before proceeding.

---

## Phase 6: FR-021 — the Monday reminder

### Overview

One scheduled job, Monday 09:00 `Europe/Warsaw`, that emails the operator when a digest is still
sitting at either human gate — and stays silent when none is.

### Changes Required:

#### 1. Outstanding-gate query

**File**: `src/lib/approval/outstanding.ts`

**Intent**: Find digests awaiting a human: status `ready_for_selection` (US-09 not done) or
`ready_for_approval` (US-16 not done), so the email can name which step is outstanding (US-17).

**Contract**: `findOutstandingGates(client) → RunStateResult<OutstandingGate[]>` where
`OutstandingGate` carries the digest, its window, and which gate it is waiting at. Takes the client
as a parameter — this module is shared-shaped and must construct nothing.

#### 2. The reminder builder

**File**: `src/lib/email/reminder.ts`

**Intent**: A pure function from the outstanding gates to an `EmailRequest` naming the step and
linking to the right page per digest — the shortlist for a selection gate, the approval page for an
approval gate.

**Contract**: `buildReminderEmail(gates, baseUrl?) → EmailRequest`. Subject names the outstanding
step when there is exactly one. Building with an empty list is a programming error the caller
prevents, not a case this function renders — the caller returns early instead.

#### 3. Registry entry and action

**Files**: `src/lib/scheduler/registry.ts`, `src/worker/scheduled-run.ts`

**Intent**: Register `approval-reminder` at Monday 09:00 and wire its action. No migration —
`tryAcquireJob` upserts the row on first fire.

**Contract**: `{ name: "approval-reminder", schedule: { dayOfWeek: 1, hour: 9, minute: 0 } }` added to
`SCHEDULED_JOBS`, and a `runApprovalReminderJob` entry in `JOB_ACTIONS`. The action returns
`{ ok: true }` when nothing is outstanding, having sent nothing. Registry stays data-only — no
`@/lib/email` import there, since the app-side lint boundary reaches it.

**Known first-fire behaviour**: `isJobDue(schedule, null, now)` is `true`
(`src/lib/scheduler/schedule.ts:124`), so a brand-new job fires on the first `scheduled-run`
invocation whatever the weekday. If a gate is outstanding at that moment the operator gets one
early reminder. That is correct behaviour, not a bug — but it should be noted in the runbook so it
is not read as a scheduling fault.

#### 4. Manual entrypoint

**Files**: `src/worker/remind.ts`, `package.json`

**Intent**: `npm run remind` — run the reminder once, on demand, so it can be verified without
waiting for a Monday.

**Contract**: Mirrors the other worker entrypoints: `main()` returning an exit code, the
`pathToFileURL` direct-execution guard (Windows paths do not form a `file://` URL by prefixing), and
no `process.exit` inside `main` itself so it stays composable.

#### 5. Tests

**Files**: `src/lib/email/reminder.test.ts`, `src/lib/approval/outstanding.test.ts`,
`src/worker/scheduled-run.test.ts`

**Intent**: Cover the builder purely, the query as an integration test, and the job's distinctive
semantics — silence when nothing is outstanding.

**Contract**: `outstanding.test.ts` claims **synthetic year 3004** and follows the standard
`configured`/purge block. The scheduled-run test adds one case using the existing ad-hoc-registry +
fake-action pattern (`:53-63,83-85`); the real `SCHEDULED_JOBS` is never used there, so the registry
entry itself needs no test change.

#### 6. Documentation

**Files**: `CLAUDE.md`, `.env.example`

**Intent**: Document `npm run remind` alongside the other worker commands, and note the second
scheduled job in the scheduler section.

**Contract**: One command entry in the Commands list and one sentence in the "Scheduling goes through
the scheduler backbone" section naming the new job and its schedule.

### Success Criteria:

#### Automated Verification:

- Reminder builder tests pass: `npx vitest run src/lib/email/reminder.test.ts`
- Outstanding-gates suite passes: `SUPABASE_TEST_PROJECT=1 npx vitest run src/lib/approval/outstanding.test.ts`
- Scheduler tests pass: `npx vitest run src/worker/scheduled-run.test.ts`
- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- Full suite passes: `npm test`

#### Manual Verification:

- `npm run remind` with a digest in `ready_for_approval` sends one email naming the approval step and
  linking to the approval page
- `npm run remind` with a digest in `ready_for_selection` names the selection step and links to the
  shortlist
- `npm run remind` with nothing outstanding sends no email and exits 0
- A second `npm run scheduled-run` in the same week does not re-fire the reminder

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation before proceeding.

---

## Phase 7: Live verification

### Overview

Drive a real digest through the gate end to end and record what actually happened. Per S-02's
lesson, a stage verified only against mocked inputs can behave qualitatively differently on real
data.

### Changes Required:

#### 1. The verification record

**File**: `context/changes/content-approval-gate/verification.md`

**Intent**: A short record of the run — digest id, story count, which emails arrived, the decisions
exercised, and the operator's verdict on whether the post was publishable. Any fix made during this
phase is recorded here rather than left implicit.

**Contract**: Follow `context/archive/2026-09-08-brand-visual-assets/verification.md` — section
headings carry the Progress row number they discharge (`(7.1)`, `(7.2)`…), and a path that was _not_
exercised live gets its own honest section saying so.

### Success Criteria:

#### Automated Verification:

- Full suite passes: `npm test`
- Linting passes: `npm run lint`

#### Manual Verification:

- A real digest reaches `ready_for_approval` and the FR-019 email arrives with a working CTA
- The operator reviews the complete post on the approval page and confirms it is publishable, having
  traced at least one key statistic back to its source article from that page alone
- Approving moves the digest to `approved` and the page becomes read-only
- On a second digest, rejecting with a note lands it in `rejected`, and `npm run generate` recovers
  it into fresh copy on the same confirmed selection
- `npm run remind` is exercised against the real project in both the outstanding and clear states
- `verification.md` records the run, including anything that did not work first time

---

## Testing Strategy

### Unit Tests:

- `buildApprovalReadyEmail` and `buildReminderEmail` as pure functions — subject, singular/plural,
  CTA present/absent, HTML escaping of Polish and Spanish text
- `approvalRequestSchema` — decision vocabulary, note length, trimming, the specific first complaint

### Integration Tests:

- `record_approval` against the real project (synthetic year 3003): approve, reject with and without
  a note, wrong status, unknown digest, double decision, over-long note — each rejection asserting
  both the SQLSTATE and that no state changed
- `findOutstandingGates` (synthetic year 3004) across both gate statuses and a clear week
- The state-machine drift guard, which is what actually proves Phase 1 landed on both sides

### Manual Testing Steps:

1. Apply both migrations through the SQL Editor; confirm the trigger and index by direct query
2. Drive a digest to `ready_for_approval` and confirm the FR-019 email arrives with a working CTA
3. On the approval page, trace one key statistic from the copy back to the source article
4. Approve through the two-step control; confirm `approved` and a read-only page
5. On a second digest, reject with a note; confirm `rejected`, the stored note, and that
   `npm run generate` recovers it
6. Run `npm run remind` with and without an outstanding gate

## Performance Considerations

The approval page issues one query per table plus a single batched `createSignedUrls` call — the same
shape as the digest page, over at most four stories and their slides. Nothing here scales with the
article pool. The reminder job reads at most a handful of rows once a week.

## Migration Notes

Two migrations, applied by hand through the Supabase SQL Editor as **separate executions** —
`db push` remains unusable on this project. The enum-value file must be executed and committed
before the file that references `'rejected'`, or Postgres raises "unsafe use of new value of enum
type". After applying, hand-edit `src/db/database.types.ts` and extend its EXCEPTION ledger;
`gen types` still returns a privileges error for this project.

**Cleared during Phase 1 (2026-09-12).** The connection problem that blocked `supabase migration
list`/`migration repair` on every prior slice (`LegacyDbConnectError: Connection timed out`) had
resolved by the time this phase ran. `npx supabase migration list` reached the project and revealed
the debt was actually **thirteen** versions, not the eight this plan was drafted against — three
older migrations (`20260727150000`, `20260727160000`, `20260729180000`) had also gone unrecorded,
predating even S-04's count. All thirteen, plus this slice's own two, were repaired in order via
`npx supabase migration repair --status applied <version>` and `migration list` now shows every
local migration matched by a remote entry. `db push` should be usable again from a machine that can
reach this same connection — worth confirming before relying on it, since the earlier failure was
never root-caused.

Existing digests are unaffected: `rejected` is a new state nothing has ever been in, and the index
redefinition only widens the set of statuses that free up a week.

## References

- Related research: `context/changes/content-approval-gate/research.md`
- State machine and drift guard: `src/lib/digest/state-machine.ts:14-40`,
  `src/lib/digest/state-machine.test.ts:15-53`
- RPC template: `supabase/migrations/20260829120000_selection_gate.sql:93-183`
- API route template: `src/pages/api/selection/confirm.ts:26-108`
- Island and hook template: `src/components/SelectionForm.tsx`, `src/components/hooks/useSelection.ts`
- Email builder and never-fail wiring: `src/lib/email/digest-ready.ts:74-96`,
  `src/worker/rank.ts:216-250`
- Scheduler surface: `src/lib/scheduler/registry.ts:8-16`, `src/worker/scheduled-run.ts:39-131`
- Verification-record format: `context/archive/2026-09-08-brand-visual-assets/verification.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: The `rejected` state

#### Automated

- [x] 1.1 State-machine drift guard passes: `npx vitest run src/lib/digest/state-machine.test.ts` — da20e5a
- [x] 1.2 Generation entrypoint tests pass: `npx vitest run src/worker/generate.test.ts` — da20e5a
- [x] 1.3 Type checking passes: `npm run build` — da20e5a
- [x] 1.4 Linting passes: `npm run lint` — da20e5a
- [x] 1.5 Full suite passes: `npm test` — da20e5a

#### Manual

- [x] 1.6 Both migrations applied; migration-repair debt cleared or explicitly re-recorded — da20e5a
- [x] 1.7 Live trigger accepts `ready_for_approval → rejected` and `rejected → generating`, rejects `rejected → published` and `rejected → approved` — da20e5a
- [x] 1.8 `one_active_digest_per_week` predicate includes `rejected` — da20e5a
- [x] 1.9 `npm run generate -- --digest=<rejected>` recovers it; the no-flag default still ignores rejected digests — da20e5a

### Phase 2: Approval record and the `record_approval` RPC

#### Automated

- [x] 2.1 Approval RPC suite passes: `SUPABASE_TEST_PROJECT=1 npx vitest run src/lib/approval/record.test.ts` — ca9fd09
- [x] 2.2 Type checking passes: `npm run build` — ca9fd09
- [x] 2.3 Linting passes: `npm run lint` — ca9fd09
- [x] 2.4 Full suite passes: `npm test` — ca9fd09

#### Manual

- [x] 2.5 `approval` applied, reachable by the service role, denied to `anon` — ca9fd09
- [x] 2.6 Approve and reject each produce the right status and exactly one `approval` row — ca9fd09

### Phase 3: Shared approval rules and the decide endpoint

#### Automated

- [x] 3.1 Rules drift guard passes: `npx vitest run src/lib/approval/rules.test.ts` — ab009f9
- [x] 3.2 Type checking passes: `npm run build` — ab009f9
- [x] 3.3 Linting passes: `npm run lint` — ab009f9
- [x] 3.4 Full suite passes: `npm test` — ab009f9

#### Manual

- [x] 3.5 Unauthenticated POST returns 401 JSON, not a redirect — ab009f9
- [x] 3.6 Malformed body 400, wrong status 409, second decision 409 (as `wrong_status`, not `already_decided` — matches the S-04 precedent; see updated criterion text) — ab009f9
- [x] 3.7 No Postgres message text appears in any response body — ab009f9

### Phase 4: The approval page and island

#### Automated

- [x] 4.1 Type checking passes: `npm run build`
- [x] 4.2 Linting passes: `npm run lint`
- [x] 4.3 Full suite passes: `npm test`

#### Manual

- [x] 4.4 Page shows copy, key statistics, originals and working source links per story
- [x] 4.5 Rendered cards load behind the PIN gate; an asset-less digest shows an empty strip, not an error
- [x] 4.6 Approve requires the second step and its summary names the right count, format and platforms (verified via correct SSR props + code review; no interactive browser available in this session to click through — see phase report)
- [x] 4.7 Reject with a note lands `rejected` and stores the note
- [x] 4.8 Post-decision page is read-only
- [x] 4.9 A rejected digest's `/dashboard/[id]` page still shows its rendered cards
- [x] 4.10 Signed out, the URL redirects to `/auth/pin`

### Phase 5: FR-019 — the approval-ready email

#### Automated

- [ ] 5.1 Builder tests pass: `npx vitest run src/lib/email/approval-ready.test.ts`
- [ ] 5.2 Worker notify tests pass: `npx vitest run src/worker/visuals.test.ts`
- [ ] 5.3 Type checking passes: `npm run build`
- [ ] 5.4 Linting passes: `npm run lint`
- [ ] 5.5 Full suite passes: `npm test`

#### Manual

- [ ] 5.6 Unconfigured email: `npm run visuals` completes and logs that email is not configured
- [ ] 5.7 Configured: the email arrives and its CTA opens the right digest's approval page

### Phase 6: FR-021 — the Monday reminder

#### Automated

- [ ] 6.1 Reminder builder tests pass: `npx vitest run src/lib/email/reminder.test.ts`
- [ ] 6.2 Outstanding-gates suite passes: `SUPABASE_TEST_PROJECT=1 npx vitest run src/lib/approval/outstanding.test.ts`
- [ ] 6.3 Scheduler tests pass: `npx vitest run src/worker/scheduled-run.test.ts`
- [ ] 6.4 Type checking passes: `npm run build`
- [ ] 6.5 Linting passes: `npm run lint`
- [ ] 6.6 Full suite passes: `npm test`

#### Manual

- [ ] 6.7 `npm run remind` names the approval step and links to the approval page
- [ ] 6.8 `npm run remind` names the selection step and links to the shortlist
- [ ] 6.9 `npm run remind` with nothing outstanding sends no email and exits 0
- [ ] 6.10 A second `scheduled-run` in the same week does not re-fire the reminder

### Phase 7: Live verification

#### Automated

- [ ] 7.1 Full suite passes: `npm test`
- [ ] 7.2 Linting passes: `npm run lint`

#### Manual

- [ ] 7.3 Real digest reaches `ready_for_approval` and the FR-019 email arrives with a working CTA
- [ ] 7.4 Operator confirms the post is publishable, having traced a key statistic to its source from the page
- [ ] 7.5 Approving lands `approved` and the page becomes read-only
- [ ] 7.6 Rejecting with a note lands `rejected`, and `npm run generate` recovers it
- [ ] 7.7 `npm run remind` exercised live in both the outstanding and clear states
- [ ] 7.8 `verification.md` records the run, including anything that did not work first time
