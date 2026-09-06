# Story Selection Gate (S-04) Implementation Plan

## Overview

Build the pipeline's first human gate. The operator opens a digest sitting in `ready_for_selection`, picks 2–4 of the 15 shortlisted stories, chooses one output format (single post / carousel) and one target-platform set (Instagram / LinkedIn / Facebook), and confirms. Confirmation is atomic: a single Postgres function writes the selection, records **every** shortlisted cluster as a labeled example (picked or passed, per US-10), and transitions the digest to `generating`. The ranking worker gains the FR-010 "digest is ready for selection" email — the first real caller of the F-04 harness.

Roadmap slice S-04. PRD refs: FR-010, FR-012, US-09, US-10.

## Current State Analysis

- **The schema deliberately stops here.** `supabase/migrations/20260722173032_digest_core_schema.sql:15` states that `selection` / `generated_asset` / `publication` / `feedback_label` are "deliberately NOT created here". This slice owns the selection half of that list.
- **The digest reaches `ready_for_selection` and stops.** `src/lib/ranking/rank.ts:260` performs the final transition; `src/worker/rank.ts:main()` then fetches the shortlist purely to print it to the console. Nothing notifies the operator, and nothing consumes the state.
- **The shortlist page renders but has no controls.** `src/pages/dashboard/[id].astro` loads ranked clusters plus their articles, picks a representative per cluster (`polish_title` present, else earliest-published), and renders read-only cards. It already forks six ways on digest status.
- **No domain API route and no React island exist yet.** `src/pages/api/auth/verify-pin.ts` is the only POST endpoint in the app, and it is a native form POST answered with a redirect. `src/components/ui/button.tsx` is the only `.tsx` file; nothing has ever been hydrated.
- **The state machine gives no way back.** `src/lib/digest/state-machine.ts:15` — `ready_for_selection → generating | skipped | failed`, and `generating → ready_for_approval | failed`. Confirmation is irreversible by design, and `state-machine.test.ts` parses the migration to fail on any drift between the SQL trigger and the TS map.
- **`article` carries no language.** Language lives only in the collection source registry (`src/lib/collection/sources.ts:43`), which app code is forbidden to import. Two enabled sources are Catalan (`Ara — Economia`, `Nació Digital — Economia`); the rest are Spanish.
- **FR-009a is unmet on the page the selection UI attaches to.** `src/pages/dashboard/[id].astro:118` uses `polish_title ?? original_title` — the original is a *fallback*, never shown alongside. The roadmap's S-03 "Delivered" note claims otherwise.

## Desired End State

A digest in `ready_for_selection` shows, at `/dashboard/<id>`, all 15 shortlisted stories with Polish title and summary **and** the Spanish/Catalan original beneath it, language-flagged. Each card carries a selection checkbox. A live counter enforces 2–4; below or above that, submit stays disabled. One format radio and one platform checkbox group apply to the whole selection. Submitting opens a review step listing exactly what will be generated; confirming POSTs to `/api/selection/confirm`, which calls `confirm_selection` and returns JSON.

After confirmation the page re-renders read-only: the same 15 stories, picks visibly marked, with a summary line naming the chosen format and platforms. The digest is in `generating`. The `selection_item` table holds 15 rows — 2–4 with `picked = true`, the rest `false` — which is the labeled-example set S-09 will consume.

Separately, when `npm run rank` (or the Sunday `scheduled-run` chain) finishes ranking, the operator receives an email listing all 15 stories as tier-colored article cards with a CTA to the digest page.

Verify by: running `npm run rank` on a digest in `ranking`, receiving the email, opening the link, selecting 3 stories, confirming, and observing the digest in `generating` with 15 `selection_item` rows.

### Key Discoveries:

- **`database.types.ts` cannot be regenerated.** Its header (`src/db/database.types.ts:8`) records that gen-types returns "account does not have the necessary privileges" for this project; four prior migrations were hand-added to it. Every schema change in this plan must be hand-added the same way and appended to that header's exception list.
- **Vitest collects `src/**/*.test.ts` only** (`vitest.config.ts:23`) — not `.tsx`. Selection logic must live in a plain-TS module to be testable; the island stays presentational. This is why the rules module precedes the UI.
- **The middleware does not protect API routes.** `src/middleware.ts:7` sets `PROTECTED_ROUTES = ["/dashboard"]`, so `/api/selection/confirm` would be reachable unauthenticated. It must not simply be added to that list either — the middleware answers with a 302 redirect to `/auth/pin`, which is wrong for a JSON endpoint.
- **"PostgREST can't express it, so make it a function" is the established pattern** — `increment_digest_cost`, `assign_articles_to_clusters` / `persist_cluster_rankings`, `record_pin_attempt`, `claim_scheduled_job`. All are `security definer`, `set search_path = public`, with execute revoked from `public`/`anon`/`authenticated` and granted only to `service_role`.
- **`renderArticleCards()` was built for this email.** The F-04 delivered note records it was added once the operator asked for per-article visibility in the digest email; `src/lib/email/layout.ts:45` defines a deliberately generic `ArticleScoreTier` of `high | medium | low` and states that a future caller maps its real tier onto that scale.
- **App code may import a new `src/lib/selection/`.** `eslint.config.js:79-92` restricts only `@/lib/collection`, `@/lib/llm`, `@/lib/email`, `@/lib/scheduler`, `@/worker`.

## What We're NOT Doing

- **No generation.** Nothing consumes the selection — S-05 owns Polish copy generation. This slice leaves the digest in `generating` with no worker to advance it, exactly as S-01 left digests in `ranking` before S-02 existed.
- **No `feedback_label` table and no rubric feedback.** Picks and passes are *stored* here; feeding them back as few-shot material is S-09.
- **No per-story format or platform.** One format and one platform set per digest (FR-012 as written).
- **No undo.** The state machine is not modified; `generating → ready_for_selection` is not added.
- **No article-level selection.** The cluster is the unit (PRD Open Question #4 — resolved in this plan).
- **No archive view.** The read-only post-confirm rendering is a by-product, not S-09's archive.
- **No retention/snapshot columns.** OQ#5 is unresolved; `selection_item` references clusters rather than copying their text.
- **No `skipped` path from the UI.** The state machine permits `ready_for_selection → skipped`, but no operator control for it is in scope.
- **No migration-history repair.** The F-01 carried-forward `supabase migration repair` debt is pre-existing and stays out of scope.

## Implementation Approach

Bottom-up, so each phase is independently verifiable and nothing is built against an interface that doesn't exist yet.

The database goes first and carries the invariants, because the write path is multi-table and the digest transition must be all-or-nothing. Then the shortlist card is completed (FR-009a) *before* controls are added to it, so the layout is settled once. Then the pure-TypeScript selection rules and the API route that enforces them server-side. Then the island, which is reduced to presentation because Vitest cannot collect it. The email lands last: it is worker-side, touches nothing the UI depends on, and its content is the shortlist the earlier phases already know how to read.

## Critical Implementation Details

**`database.types.ts` is hand-maintained for this project.** Do not run `npx supabase gen types` and assume it works — the header records that it returns a privileges error. Add the new tables, enums, and functions by hand in the same shape as the existing entries, and extend the header's EXCEPTION list with this slice's migrations. Getting this wrong surfaces as type errors across the API route and both Astro pages.

**The transition guard runs inside `confirm_selection`.** The `digest_transition_guard` BEFORE UPDATE trigger fires on the function's own `update digest set status = 'generating'`, so an attempt to confirm a digest that is not in `ready_for_selection` is rejected by the database even if the function's own status check were bypassed. The function should still check status explicitly first, so the operator gets a specific message rather than `check_violation`.

**Migrations are applied through the Supabase SQL Editor on this project**, not `db push` — see the F-01 carried-forward note. Apply the SQL by hand after writing the migration file, then hand-edit the types.

## Phase 1: Selection schema & atomic confirm function

### Overview

Create the two tables that hold a confirmed selection and its labeled examples, plus the single Postgres function that validates and writes the whole gate in one transaction.

### Changes Required:

#### 1. Selection schema migration

**File**: `supabase/migrations/20260829120000_selection_gate.sql`

**Intent**: Add the tables S-04 owns and the atomic confirm path, following the deny-by-default RLS and `security definer` RPC conventions the existing migrations establish.

**Contract**:

- Enums `selection_format` (`single_post`, `carousel`) and `selection_platform` (`instagram`, `linkedin`, `facebook`).
- `selection` — one row per confirmed digest: `id uuid pk`, `digest_id uuid not null unique references digest(id) on delete cascade`, `format selection_format not null`, `platforms selection_platform[] not null` with a check that at least one platform is present, `confirmed_at timestamptz not null default now()`, `created_at`. The `unique` on `digest_id` is what makes double-confirm impossible independently of the state machine.
- `selection_item` — one row per **shortlisted** cluster: `id uuid pk`, `selection_id uuid not null references selection(id) on delete cascade`, `cluster_id uuid not null references cluster(id) on delete cascade`, `picked boolean not null`, `created_at`, `unique (selection_id, cluster_id)`, index on `selection_id`.
- RLS enabled with **no policies** on both tables, matching `digest`/`cluster`/`article`.
- Comments on both tables naming US-10 and the S-09 consumer, so the "why are passes stored" question is answered at the schema.

#### 2. The confirm function

**File**: `supabase/migrations/20260829120000_selection_gate.sql` (same migration)

**Intent**: Do the entire gate — validate, write both tables, transition the digest — in one transaction, so a partial write cannot leave a confirmed selection on a digest still in `ready_for_selection`.

**Contract**: `public.confirm_selection(p_digest_id uuid, p_shortlist_cluster_ids uuid[], p_picked_cluster_ids uuid[], p_format selection_format, p_platforms selection_platform[]) returns uuid` — the new selection's id. `language plpgsql`, `security definer`, `set search_path = public`. Execute revoked from `public`/`anon`/`authenticated`, granted to `service_role` only.

Validations, each raising a distinct message so the API route can map them:

- the digest exists and its status is `ready_for_selection`;
- `p_picked_cluster_ids` has between 2 and 4 **distinct** entries;
- every picked id appears in `p_shortlist_cluster_ids`;
- every shortlist id names a cluster whose `digest_id` matches and whose `rank` is not null.

Then: insert the `selection` row; insert one `selection_item` per shortlist id with `picked = (id = any(p_picked_cluster_ids))` via `unnest`; `update digest set status = 'generating' where id = p_digest_id`.

The caller passes the shortlist explicitly rather than letting the function re-derive it, so what the operator saw is what gets labeled — a re-rank between page load and confirm cannot silently relabel a different set.

#### 3. Generated types

**File**: `src/db/database.types.ts`

**Intent**: Hand-add the new tables, enums, and function so the app compiles against them.

**Contract**: `selection` and `selection_item` under `public.Tables` (Row/Insert/Update/Relationships), `selection_format` and `selection_platform` under `public.Enums`, `confirm_selection` under `public.Functions` with its Args and `Returns: string`. Append this migration to the EXCEPTION list in the file header.

#### 4. Integration coverage

**File**: `src/lib/selection/confirm.test.ts`

**Intent**: Prove the function's invariants against the real database, in the style of the existing run-state integration suites (skipped unless `SUPABASE_TEST_PROJECT=1`).

**Contract**: Seed a digest in `ready_for_selection` with ranked clusters, then assert: a valid 3-pick confirm writes one `selection` and N `selection_item` rows with the right `picked` flags and moves the digest to `generating`; 1 pick and 5 picks are both rejected; a pick outside the shortlist is rejected; a digest in the wrong status is rejected; and a second confirm on the same digest is rejected. After each rejection, assert the digest status is unchanged — that is the atomicity claim.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass: `npm run build`
- Selection integration suite passes: `SUPABASE_TEST_PROJECT=1 npm test`
- Full suite passes with no regression in the state-machine drift guard: `npm test`

#### Manual Verification:

- Migration applied through the Supabase SQL Editor without error
- `confirm_selection` called directly from the SQL Editor on a scratch digest produces the expected rows and transition
- Both new tables reject a direct read through the publishable (anon) key

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Show the original alongside the translation (FR-009a)

### Overview

Close the gap found during planning: the shortlist card shows Polish text with the Spanish/Catalan original only as a fallback. The operator is about to make an irreversible editorial call on this card, which is precisely when FR-009a's "check the translation against the source" matters. Language is not on the article row today, so it is added.

### Changes Required:

#### 1. Article language column

**File**: `supabase/migrations/20260829130000_article_language.sql`

**Intent**: Record each article's publication language on the row, so the app can flag the original without importing the worker-side source registry (which ESLint forbids).

**Contract**: `alter table article add column language text` (nullable), with a check constraint allowing `null`, `'es'`, or `'ca'` — mirroring `SOURCE_LANGUAGES` in `src/lib/collection/sources.ts`. Backfill existing rows from `source_name`: `'ca'` for `Ara — Economia` and `Nació Digital — Economia`, `'es'` otherwise. Nullable rather than `not null` so a future source added before its backfill lands renders unflagged instead of failing an insert.

#### 2. Collection writes the language

**File**: `src/lib/collection/collect.ts`

**Intent**: Populate the new column at insert time from the source registry, which already has `source.language` in hand where it sets `source_name`.

**Contract**: The article insert payload gains `language: source.language`. No behavior change otherwise.

#### 3. Generated types

**File**: `src/db/database.types.ts`

**Intent**: Add `language: string | null` to the `article` Row/Insert/Update and record the migration in the header's exception list.

**Contract**: `article.language` present in all three shapes; header updated.

#### 4. Card renders both languages

**File**: `src/pages/dashboard/[id].astro`

**Intent**: Render the original title and lede beneath the Polish, each side language-flagged, instead of using the original only when translation is missing.

**Contract**: `ShortlistItem` gains `originalTitle`, `originalLede`, and `originalLanguage: string | null`. The card shows the Polish title/summary under a `PL` flag and the original under an `ES`/`CA` flag (omit the flag when `language` is null). When a cluster is untranslated the existing `untranslated` marker stays and the original is not duplicated. `escapeHtml` is not needed — Astro escapes interpolated text by default.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass: `npm run build`
- Collection suite still passes: `npm test`

#### Manual Verification:

- A shortlisted story shows Polish and original text simultaneously, each flagged
- A story from `Ara — Economia` or `Nació Digital — Economia` is flagged `CA`, not `ES`
- An untranslated cluster renders once, not twice, and keeps its `untranslated` marker

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Selection rules module & confirm API route

### Overview

The server-side authority on what a valid selection is, in a plain-TS module both the API route and the island import, plus the endpoint that calls `confirm_selection`.

### Changes Required:

#### 1. Selection rules

**File**: `src/lib/selection/rules.ts`

**Intent**: Own the selection vocabulary and the 2–4 rule in one testable place, so the island's affordance and the route's enforcement cannot disagree.

**Contract**: Exported `MIN_PICKS = 2`, `MAX_PICKS = 4`, `SELECTION_FORMATS` and `SELECTION_PLATFORMS` as const arrays matching the Postgres enums, and a zod `selectionRequestSchema` covering `{ digestId, shortlistClusterIds, pickedClusterIds, format, platforms }` — including the distinct-picks, picks-⊆-shortlist, and at-least-one-platform checks. App-side module; safe for both the route and the island to import.

#### 2. Shared types

**File**: `src/types.ts`

**Intent**: Add the selection result idiom alongside the existing `RunStateResult` / `LlmResult` / `EmailResult` family.

**Contract**: `SelectionFormat` and `SelectionPlatform` derived from the generated `Database` enums; `SelectionErrorReason` covering `invalid_request | wrong_status | already_confirmed | not_found | not_configured | database_error`; `SelectionError` and `SelectionResult<T>` in the established `{ ok: true, data } | { ok: false, reason, message }` shape.

#### 3. Confirm endpoint

**File**: `src/pages/api/selection/confirm.ts`

**Intent**: Authenticate, validate, call the RPC, and answer JSON — the app's first domain route.

**Contract**: `export const prerender = false;` and a `POST` handler. Order is load-bearing: reject with `401` when `context.locals.operatorAuthenticated` is false **before** parsing the body — the middleware's `PROTECTED_ROUTES` only covers `/dashboard` and answers with a 302, which is wrong for JSON. Then parse and validate with `selectionRequestSchema` (`400` on failure), build the service client (`503` when null, matching the pages' handling), and call `confirm_selection`. Map the function's raised messages onto `SelectionErrorReason`: wrong status → `409`, unique violation on `digest_id` → `409 already_confirmed`, everything else → `500` with the code and message logged server-side, in the style of the existing `console.error` lines in the dashboard pages.

#### 4. Rules coverage

**File**: `src/lib/selection/rules.test.ts`

**Intent**: Cover the boundary conditions the island's UI will rely on.

**Contract**: Accepts 2, 3, and 4 picks; rejects 0, 1, and 5; rejects duplicate picks; rejects a pick absent from the shortlist; rejects an empty platform list; rejects an unknown format or platform string.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass: `npm run build`
- Rules suite passes: `npm test`

#### Manual Verification:

- `POST /api/selection/confirm` with no session cookie returns 401 JSON, not a redirect to `/auth/pin`
- A valid request against a real `ready_for_selection` digest returns 200 and moves it to `generating`
- Re-posting the same request returns 409, not 500

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Selection UI island & post-confirm view

### Overview

The operator-facing gate: a hydrated React island on the shortlist page for a digest awaiting selection, and a read-only rendering of the same list once it has been confirmed.

### Changes Required:

#### 1. Selection state hook

**File**: `src/components/hooks/useSelection.ts`

**Intent**: Hold the island's state and derive its validity from the shared rules module, per CLAUDE.md's convention that hooks live here.

**Contract**: Takes the shortlist cluster ids; returns the picked set with a toggle, the chosen format and platform set with setters, a derived `canSubmit`, the live pick count, and the submit call that POSTs to `/api/selection/confirm`. Validity is computed via `src/lib/selection/rules.ts`, never re-implemented.

#### 2. Selection form island

**File**: `src/components/SelectionForm.tsx`

**Intent**: Render the controls and the review-and-confirm step the operator passes through before an irreversible transition.

**Contract**: Props are the digest id and the shortlist items (cluster id, rank, Polish title). Renders a checkbox per story, a live "n of 2–4 selected" counter, a single-choice format control, a multi-choice platform control, and a submit disabled until `canSubmit`. Submitting opens a review step listing the chosen titles, format, and platforms with an explicit confirm — this is the only guard against a misclick, since the transition has no undo. On success, reload the page so the server re-renders the confirmed state; on failure, surface the endpoint's message inline without clearing the operator's choices. Uses the existing `Button` from `src/components/ui/button.tsx` and `cn()` from `@/lib/utils`; no new dependencies.

#### 3. Page wiring and post-confirm rendering

**File**: `src/pages/dashboard/[id].astro`

**Intent**: Mount the island only where selection is actually open, and otherwise show what was decided.

**Contract**: Alongside the existing cluster/article queries, load the digest's `selection` and its `selection_item` rows. When `digest.status === "ready_for_selection"` and no selection exists, render `<SelectionForm client:load … />` over the shortlist. When a selection exists, render the same 15 cards read-only with picked ones visibly marked, above a summary line naming the format and platforms. The existing `!client` / `loadError` / not-ready / `failed` / empty branches are unchanged, and a query error on the selection tables follows the F2 precedent from S-03's impl-review — a distinct failure message, not a silent empty state.

### Success Criteria:

#### Automated Verification:

- Lint passes on `.tsx` and `.astro`: `npm run lint`
- Type check and build pass, with the island bundled: `npm run build`
- No test regressions: `npm test`

#### Manual Verification:

- With 0 or 1 stories checked the submit control is disabled; at 2 it enables; at 5 it disables again
- The review step lists exactly the chosen titles, format, and platforms
- Confirming moves the digest to `generating` and the page re-renders read-only with the picks marked
- The shortlist for a digest already past `ready_for_selection` shows no controls
- A rejected confirm shows the message inline and leaves the operator's choices intact

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 5: FR-010 digest-ready email

### Overview

Tell the operator the gate is open. The first real caller of the F-04 harness, sent from the ranking worker's entrypoint after a successful run.

### Changes Required:

#### 1. Dashboard URL configuration

**File**: `src/worker/env.ts`, `.env.example`

**Intent**: Give the email a link target; the worker has no notion of where the dashboard lives.

**Contract**: `DASHBOARD_BASE_URL: z.url().optional()` in the worker env schema — optional like the Gmail credentials, so an unconfigured worker still runs. Documented in `.env.example` next to the F-04 block, noting it is the Cloudflare Tunnel hostname.

#### 2. Email body builder

**File**: `src/lib/email/digest-ready.ts`

**Intent**: Turn a digest and its shortlist into an `EmailRequest`, as a pure function so it is testable without a transport.

**Contract**: `buildDigestReadyEmail(digest, items, baseUrl)` returning `EmailRequest`. Items map onto `ArticleCard`: Polish title, `source_url` as the link, Polish summary as the description, coverage count as the meta line, and the geography tier mapped onto the generic scale `ArticleScoreTier` documents — `catalonia → high`, `national → medium`, `global`/`discard` → `low` — with the real tier name as the score label. The CTA points at `<baseUrl>/dashboard/<id>`; when no base URL is configured the CTA is omitted rather than emitting a broken link. Subject names the week window.

#### 3. Worker sends it

**File**: `src/worker/rank.ts`

**Intent**: Send the notification after a successful ranking run, without ever letting an email problem fail the pipeline.

**Contract**: `fetchShortlist` additionally returns each cluster's id and its representative article's Polish title, summary and `source_url` — the same representative rule `[id].astro` uses. After the existing shortlist print, build the transport with `createEmailClient({ user: env.GMAIL_USER, appPassword: env.GMAIL_APP_PASSWORD })`, call `sendEmail(transport, env.OPERATOR_EMAIL, buildDigestReadyEmail(…))`, and log the outcome. A `not_configured` result logs at info level and is not a failure; any other failure logs an error but the function still returns `0` — ranking succeeded, and `runCollectionJob` in `scheduled-run.ts` must not treat a missed email as a failed job.

#### 4. Builder coverage

**File**: `src/lib/email/digest-ready.test.ts`

**Intent**: Cover the mapping and the URL edge case without sending anything.

**Contract**: All three tier mappings produce the right `ArticleScoreTier`; an unknown or null tier degrades to `low` rather than throwing; the CTA is present with a base URL and absent without one; the subject contains the week window; an untranslated item falls back to its original title rather than rendering empty.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass: `npm run build`
- Email builder suite passes: `npm test`

#### Manual Verification:

- `npm run rank` on a real digest delivers the email to `OPERATOR_EMAIL`
- All 15 stories appear as cards with tier-appropriate colors
- The CTA opens the correct digest page through the tunnel hostname
- With Gmail credentials unset, `npm run rank` completes normally and logs that email is not configured

---

## Testing Strategy

### Unit Tests:

- `src/lib/selection/rules.test.ts` — pick-count boundaries (0/1/2/4/5), duplicate picks, picks outside the shortlist, empty platforms, unknown format/platform strings.
- `src/lib/email/digest-ready.test.ts` — tier mapping including the unknown-tier degradation, CTA presence with and without a base URL, subject content, untranslated fallback.

### Integration Tests:

- `src/lib/selection/confirm.test.ts` (skipped unless `SUPABASE_TEST_PROJECT=1`) — the full `confirm_selection` contract against the real database: happy path row counts and flags, every rejection case, double-confirm, and the digest status left untouched after each rejection.

### Manual Testing Steps:

1. Run `npm run rank` on a digest in `ranking`; confirm the email arrives with 15 cards and a working CTA.
2. Open the digest page; confirm Polish and original text appear together, correctly flagged (check one Catalan source).
3. Check one story — submit disabled. Check a second — enabled. Check a fifth — disabled again.
4. Select 3, choose carousel and two platforms, submit, and confirm at the review step.
5. Confirm the digest reads `generating`, the page is read-only, and the picks are marked.
6. Query `selection_item` — 15 rows, 3 with `picked = true`.
7. Reload and re-POST the same request via `curl`; expect 409.
8. `curl` the endpoint with no session cookie; expect 401 JSON.

## Performance Considerations

Nothing here is hot. The page adds two small queries (one `selection`, one `selection_item` bounded by the shortlist size of 15) to a page that already runs two. The confirm path is a single RPC. The email adds one query for representative articles and one SMTP send per weekly run.

## Migration Notes

Two migrations, applied through the Supabase SQL Editor rather than `db push` — the path this project has used since F-01, whose carried-forward note records that migration history needs a `supabase migration repair` before `db push` is usable again. That repair stays out of scope here.

`article.language` is backfilled from `source_name` in its own migration, so existing digests render correctly rather than only new ones. It is nullable by design: a source added later without a backfill renders unflagged instead of breaking collection.

No rollback is destructive — both new tables are additive and cascade from `digest`; dropping them leaves the pipeline exactly as it is today, with digests parked in `ready_for_selection`.

## References

- Roadmap slice: `context/foundation/roadmap.md` § S-04
- PRD: `context/foundation/prd.md` — FR-010, FR-012, US-09, US-10; Open Question #4 (resolved in this plan: the cluster is the unit)
- Schema conventions: `supabase/migrations/20260722173032_digest_core_schema.sql`, `supabase/migrations/20260727150000_bulk_ranking_writes.sql:56` (RPC grant pattern)
- Email harness and card primitive: `src/lib/email/layout.ts:45`, `src/lib/email/send.ts:34`
- State machine: `src/lib/digest/state-machine.ts:15`
- The page being extended: `src/pages/dashboard/[id].astro`
- API route precedent: `src/pages/api/auth/verify-pin.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Selection schema & atomic confirm function

#### Automated

- [x] 1.1 Lint passes: `npm run lint` — 50f6515
- [x] 1.2 Type check and build pass: `npm run build` — 50f6515
- [x] 1.3 Selection integration suite passes: `SUPABASE_TEST_PROJECT=1 npm test` — 50f6515
- [x] 1.4 Full suite passes with no regression in the state-machine drift guard: `npm test` — 50f6515

#### Manual

- [x] 1.5 Migration applied through the Supabase SQL Editor without error — 50f6515
- [x] 1.6 `confirm_selection` called directly from the SQL Editor produces the expected rows and transition — 50f6515
- [x] 1.7 Both new tables reject a direct read through the publishable (anon) key — 50f6515

### Phase 2: Show the original alongside the translation (FR-009a)

#### Automated

- [x] 2.1 Lint passes: `npm run lint` — 7625131
- [x] 2.2 Type check and build pass: `npm run build` — 7625131
- [x] 2.3 Collection suite still passes: `npm test` — 7625131

#### Manual

- [x] 2.4 A shortlisted story shows Polish and original text simultaneously, each flagged — 7625131
- [x] 2.5 A Catalan-source story is flagged `CA`, not `ES` — 7625131
- [x] 2.6 An untranslated cluster renders once, not twice, and keeps its `untranslated` marker — 7625131

### Phase 3: Selection rules module & confirm API route

#### Automated

- [x] 3.1 Lint passes: `npm run lint` — babbdc2
- [x] 3.2 Type check and build pass: `npm run build` — babbdc2
- [x] 3.3 Rules suite passes: `npm test` — babbdc2

#### Manual

- [x] 3.4 `POST /api/selection/confirm` with no session cookie returns 401 JSON, not a redirect — babbdc2
- [x] 3.5 A valid request against a real `ready_for_selection` digest returns 200 and moves it to `generating` — babbdc2
- [x] 3.6 Re-posting the same request returns 409, not 500 — babbdc2

### Phase 4: Selection UI island & post-confirm view

#### Automated

- [x] 4.1 Lint passes on `.tsx` and `.astro`: `npm run lint` — 2c6c167
- [x] 4.2 Type check and build pass, with the island bundled: `npm run build` — 2c6c167
- [x] 4.3 No test regressions: `npm test` — 2c6c167

#### Manual

- [x] 4.4 Submit is disabled at 0–1 picks, enabled at 2, disabled again at 5 — 2c6c167
- [x] 4.5 The review step lists exactly the chosen titles, format, and platforms — 2c6c167
- [x] 4.6 Confirming moves the digest to `generating` and re-renders read-only with picks marked — 2c6c167
- [x] 4.7 A digest past `ready_for_selection` shows no controls — 2c6c167
- [x] 4.8 A rejected confirm shows the message inline and leaves choices intact — 2c6c167

### Phase 5: FR-010 digest-ready email

#### Automated

- [x] 5.1 Lint passes: `npm run lint` — b933aea
- [x] 5.2 Type check and build pass: `npm run build` — b933aea
- [x] 5.3 Email builder suite passes: `npm test` — b933aea

#### Manual

- [x] 5.4 `npm run rank` on a real digest delivers the email to `OPERATOR_EMAIL` — 2026-09-06: closed
      through the real entrypoint. `npm run rank --digest=c92aa3c5` on a fresh 108-article digest
      transitioned it to `ready_for_selection` ($0.3618) and sent the notification, exit 0. — b933aea
- [x] 5.5 All 15 stories appear as cards with tier-appropriate colors — 2026-09-06: digest `c92aa3c5`
      yields 15 cards, 8 `catalonia` → green pill (`#dcfce7`/`#15803d`) and 7 `national` → amber
      (`#fef3c7`/`#b45309`). Two distinct tier colors confirmed in the delivered HTML. — b933aea
- [ ] 5.6 The CTA opens the correct digest page through the tunnel hostname — partially: the CTA renders
      and carries the right digest id, verified at `http://localhost:4321`. Not yet re-sent with
      `DASHBOARD_BASE_URL` pointing at the real Cloudflare Tunnel host — the tunnel is not stood up yet,
      so this is deferred rather than failing.
- [x] 5.7 With Gmail credentials unset, `npm run rank` completes normally and logs that email is not
      configured — covered against the real database by `notifyDigestReady (integration)` in
      `src/worker/rank.test.ts` ("resolves quietly when email is not configured", plus a transport-failure
      and an empty-cluster case). The `main()` wrapper itself was not run credential-less. — b933aea
