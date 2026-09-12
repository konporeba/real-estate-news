# Brand Visual Assets (S-06) Implementation Plan

## Overview

Turn each generated Polish story into a branded square PNG by filling named text boxes in
operator-owned Google Slides decks, storing the results in Supabase Storage, and showing them
read-only on the digest page. This is roadmap slice **S-06** (FR-015, US-13, US-14) and the last
prerequisite blocking S-07's approval gate.

The design lives in Google Slides, owned and edited by the operator. The worker never designs
anything — it duplicates a template slide, substitutes `{{PLACEHOLDER}}` text, exports the page as
PNG, and cleans up. A restyle is a deck edit; no code change, no deploy (US-13).

## Current State Analysis

**What exists.** The upstream contract is complete and was designed for this slice:

- `generated_copy` (`supabase/migrations/20260906150000_generated_copy.sql`) holds
  `polish_title`, `caption_summary`, `body_copy`, `key_statistics` (jsonb array of
  `{label, value}`), one row per selected cluster. Its own table comment states *"S-06 fills
  visual template slots from these columns"*.
- `selection` carries `format` (`single_post` | `carousel`) and `platforms`
  (`instagram` | `linkedin` | `facebook`) — `src/lib/selection/rules.ts:22-33`.
- The worker stage pattern is established three times over (`collect.ts`, `rank.ts`,
  `generate.ts`): an orchestrator in `src/lib/<stage>/` that composes pure steps, transitions the
  digest, and returns `RunStateResult`; a thin entrypoint in `src/worker/` that resolves the
  target digest, refuses a wrong-status digest with exit 2, and never calls `process.exit` from
  the orchestrator itself.
- `markStageComplete(client, digestId, stage)` stamps per-stage checkpoints via a
  `STAGE_CHECKPOINT` record (`src/lib/digest/run-state.ts:35`).

**What is missing.**

- No `generated_asset` table. F-01 deliberately deferred it ("Later slices own selection /
  generated_asset / publication / feedback_label").
- No `rendering` state. `generateDigest()` transitions `generating → ready_for_approval`
  directly (`src/lib/generation/generate.ts`, tail).
- No binary storage anywhere. No Supabase Storage bucket, no image dependency in `package.json`.
- No Google API client or credentials in `src/worker/env.ts`.

**Constraints discovered.**

- **Canva is ruled out, empirically.** Canva's Autofill API requires the acting user to be a
  member of a Canva Enterprise organization — for both the `create_from_brand_template` and
  `create_from_design` modes. The operator verified against their own Pro account that
  membership is required. Roadmap OQ#2 is hereby closed: **no**.
- **Google Slides autofit does not survive an API text edit.** `autofit` is reset to `NONE` and
  the font scale returned to default whenever a request is made that might affect text fitting,
  which `replaceAllText` always is. Text fitting must therefore be computed by the worker.
- **`getThumbnail` needs only `https://www.googleapis.com/auth/presentations`** — the same scope
  as `batchUpdate`. No Drive scope, no second consent surface.
- **`getThumbnail` returns a URL with a 30-minute lifetime**, so the bytes must be downloaded and
  re-hosted or the archive rots within the hour (FR-024 requires full-fidelity retention).
- **A service account has no consumer Drive storage quota**, so the worker must never create a
  Drive file. It operates inside decks the operator owns and shares.
- **The transition-guard drift guard parses the LATEST migration defining
  `enforce_digest_transition`** (`src/lib/digest/state-machine.test.ts:15-54`), so a new
  migration must reproduce the entire function body verbatim plus the new clauses.

### Key Discoveries:

- `generated_copy.key_statistics` is jsonb and unqueried by design — the migration comment says
  "neither S-06's slot filling nor S-07's rendering queries inside it", so reading it whole in TS
  is the sanctioned access pattern.
- `ReplaceAllTextRequest` accepts `pageObjectIds`, which is what makes per-story values possible
  in a single multi-slide deck — without it, one `replaceAllText` would overwrite every slide.
- The partial unique index `one_active_digest_per_week` (`20260722173032`, line 52) excludes
  terminal states by name; `rendering` is non-terminal, so the index needs no change and must
  **not** be redefined — the drift guard resolves it by predicate to the latest file defining it.
- `src/pages/dashboard/[id].astro:26` already loads the digest with `createServiceClient()` from
  `@/lib/supabase-admin`, so the preview has a client to sign storage URLs with.
- S-05's carried-forward lesson, verbatim from the roadmap: *"a stage that can fail needs a
  recovery path proportional to its cost"*. That is the whole argument for a separate `rendering`
  state rather than folding this into `generating`.

## Desired End State

`npm run visuals` takes a digest the generation stage left in `rendering` and produces one PNG per
carousel slide (or one per story, for a single post) in a private Supabase Storage bucket, with a
`generated_asset` row per image, then transitions the digest to `ready_for_approval`. The operator
opens the digest page and sees the rendered cards. Editing a deck in Google Slides changes the
next run's output with no code change.

Verified by: a real end-to-end run on a live digest whose images the operator confirms are
publishable, plus `npm test` and `npm run lint` green.

## What We're NOT Doing

- **No Canva integration of any kind.** Autofill is Enterprise-gated; Bulk Create was rejected as
  reintroducing a manual weekly step.
- **No per-platform templates.** One square 1080×1080 template per format serves Instagram,
  LinkedIn and Facebook alike. US-14 is satisfied degenerately — every platform's asset comes from
  the template matching its format, and today that is the same template. `generated_asset`
  deliberately has **no `platform` column**; adding one is a cheap later migration if templates
  ever diverge.
- **No image post-processing.** Slides exports at 1600px on the constrained edge; that is stored
  as-is. No resizing library is added.
- **No approve/reject controls.** The preview is read-only; FR-019/020/021 belong to S-07.
- **No changes to S-05's prompt or copy quality.** The length gate lives in this stage.
- **No publishing.** S-08 owns which asset goes to which platform.
- **No scheduler wiring.** Like `generate`, this stage sits behind a human gate and stays manual.

## Implementation Approach

A new `rendering` state sits between `generating` and `ready_for_approval`, with `failed →
rendering` for retry-in-place. The stage is driven by its own entrypoint so a render failure never
forces re-payment of the dollar-sized copy generation.

Rendering works entirely inside the operator's shared decks, creating no Drive files:

1. Duplicate the story template slide once per story (`duplicateObject` — a page object inside an
   existing presentation, not a Drive file).
2. For each duplicated page: locate the placeholder shapes, compute the title font size from the
   value about to be inserted, apply it with `updateTextStyle`, then `replaceAllText` scoped to
   that page's `pageObjectIds`.
3. Export each page via `pages.getThumbnail` (`LARGE`), download the bytes before the 30-minute
   URL expires, upload to Supabase Storage.
4. Delete the duplicated pages, restoring the deck to its template state.

Step 4 must run whether or not steps 2-3 succeeded, and the stage sweeps leftover duplicates on
start, because the deck is long-lived mutable state shared with a human.

## Critical Implementation Details

**Ordering: font size before text.** The title's font size is computed from the string about to be
inserted, and applied while the box still contains `{{TITLE}}`. The placeholder shape can only be
located by searching for its placeholder text, so the lookup must happen before `replaceAllText`
consumes it. Doing it after means searching for the inserted Polish title, which is not a stable
identifier. Order per page: read shapes → resolve object ids → `updateTextStyle` → `replaceAllText`.

**The enum value needs its own migration.** `alter type digest_status add value 'rendering'` cannot
be used by any statement in the same transaction that adds it. Ship it as a standalone migration
file ahead of the one that redefines the trigger, and reference `'rendering'` only inside the
plpgsql function body (a string literal, evaluated at runtime, so it is safe there).

**Deck state is shared with a human.** The operator may have the deck open while the worker
mutates it. Duplicated pages carry a recognisable object-id prefix so a crashed run's leftovers
are identifiable and swept on the next start rather than accumulating silently.

**Service-account private keys and dotenv.** The PEM contains literal newlines. F-02 already lost a
day to `.dev.vars` silently truncating `PIN_PEPPER` at a `#` (see the S-03 roadmap entry), so the
key is stored base64-encoded in a single env var and decoded at load, rather than relying on
`\n`-escaping surviving two dotenv parsers.

---

## Phase 1: Schema, state, and storage bucket

### Overview

Add the `rendering` state to both the database and its TypeScript mirror, create the
`generated_asset` table and the private Storage bucket, and extend the stage-checkpoint machinery.

### Changes Required:

#### 1. Enum value

**File**: `supabase/migrations/<ts>_rendering_status_enum.sql`

**Intent**: Add `rendering` to `digest_status`, alone in its own migration so nothing in the same
transaction uses it.

**Contract**: `alter type digest_status add value 'rendering' after 'generating';`

#### 2. Transition trigger, checkpoint, table, bucket

**File**: `supabase/migrations/<ts>_visual_assets.sql`

**Intent**: Redefine `enforce_digest_transition` to route `generating → rendering →
ready_for_approval` and allow `failed → rendering`; add the `rendering_completed_at` checkpoint;
create `generated_asset`; create the private Storage bucket.

**Contract**: The function is reproduced verbatim from `20260908120000_failed_generation_retry.sql`
with exactly three clause changes — `generating` now targets `('rendering', 'failed')`, a new
`rendering → ('ready_for_approval', 'failed')` clause, and `failed` gains `'rendering'`. Do **not**
redefine `one_active_digest_per_week`; `rendering` is non-terminal and the predicate is unchanged.

`generated_asset` columns: `id uuid pk`, `digest_id uuid not null references digest on delete
cascade`, `cluster_id uuid references cluster on delete cascade` (nullable — the carousel cover
belongs to no story), `slide_index integer not null`, `storage_path text not null`, `width
integer`, `height integer`, `format selection_format not null`, `created_at timestamptz not null
default now()`, `unique (digest_id, slide_index)`, index on `digest_id`. RLS enabled with no
policies, matching every other table.

Bucket: `insert into storage.buckets (id, name, public) values ('digest-assets', 'digest-assets',
false) on conflict (id) do nothing;`

#### 3. TypeScript state mirror

**File**: `src/lib/digest/state-machine.ts`

**Intent**: Mirror the new transitions so the drift guard passes and the app can reason about the
state without a round trip.

**Contract**: `TRANSITIONS.generating` becomes `["rendering", "failed"]`; a `rendering` key is
added; `TRANSITIONS.failed` gains `"rendering"`. `TERMINAL_STATES` is unchanged.

#### 4. Stage checkpoint

**File**: `src/lib/digest/run-state.ts`, `src/types.ts`

**Intent**: Let `markStageComplete(client, digestId, "rendering")` stamp the new column.

**Contract**: `DigestStage` gains `"rendering"`; `STAGE_CHECKPOINT` gains the corresponding entry
writing `rendering_completed_at`. Add `GeneratedAssetRow` alongside `GeneratedCopyRow`
(`src/types.ts:160`).

#### 5. Regenerated database types

**File**: `src/db/database.types.ts`

**Intent**: Pick up the new enum value, table and column.

**Contract**: Regenerated output only — no hand edits.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- State-machine drift guard passes: `npx vitest run src/lib/digest/state-machine.test.ts`
- Full suite passes: `npm test`

#### Manual Verification:

- Both migrations applied to the Supabase project, and the six-migration `supabase migration repair` debt inherited from F-01/S-05 is either cleared or explicitly re-recorded as still outstanding
- `digest-assets` bucket exists and is private in the Supabase dashboard
- A digest can be moved `generating → rendering → ready_for_approval` by hand, and `generating → ready_for_approval` is now rejected

---

## Phase 2: Slides client, template spec, and validator

### Overview

Authenticate as the service account, wrap the three Slides calls the stage needs, publish the deck
spec the operator builds against, and ship a validator that checks their decks before the pipeline
ever runs.

### Changes Required:

#### 1. Dependency and worker config

**File**: `package.json`, `src/worker/env.ts`, `.env.example`

**Intent**: Add JWT auth for the service account and the config the stage needs.

**Contract**: Add `google-auth-library` (not the full `googleapis` bundle — only JWT signing and
`getRequestHeaders()` are needed; the three REST calls go through `fetch`). New env vars, all
optional so the worker still starts unconfigured, mirroring the Gmail treatment:
`GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY_B64`, `SLIDES_DECK_SINGLE_POST`,
`SLIDES_DECK_CAROUSEL`, `SUPABASE_ASSET_BUCKET` (default `digest-assets`).

#### 2. Slides transport

**File**: `src/lib/visuals/slides-client.ts`

**Intent**: A thin, injectable transport over the three operations the stage performs, returning
the `{ ok, reason }` idiom rather than throwing — the same contract as `createEmailClient` /
`createLlmClient`.

**Contract**: `createSlidesClient(config)` returns `null` when config is absent. The transport
exposes `getPresentation(id)`, `batchUpdate(id, requests)`, and `getPageThumbnail(id, pageId)`.
Scope is `https://www.googleapis.com/auth/presentations`. Failure reasons:
`not_configured | auth_failed | not_found | permission_denied | api_error`.

#### 3. Template specification

**File**: `context/changes/brand-visual-assets/template-spec.md`

**Intent**: The document the operator builds their decks from — the sole definition of the
contract between their design work and the code.

**Contract**: Page setup 1080×1080 px, both decks. Single-post deck: one slide. Carousel deck: two
slides — slide 1 is the cover, slide 2 is the story template that gets duplicated. Placeholders,
exact strings: `{{TITLE}}`, `{{STAT_1_LABEL}}`, `{{STAT_1_VALUE}}`, `{{STAT_2_LABEL}}`,
`{{STAT_2_VALUE}}`, `{{STAT_3_LABEL}}`, `{{STAT_3_VALUE}}`; cover slide adds `{{COVER_TITLE}}` and
`{{COVER_SUBTITLE}}`. Each placeholder occupies its own text box. Both decks shared with
`GOOGLE_SA_EMAIL` as **Editor**.

#### 4. Deck validator

**File**: `src/worker/validate-decks.ts`, `package.json` script

**Intent**: Turn a mistyped placeholder from a mid-pipeline broken image into a setup-time error.

**Contract**: `npm run visuals:validate` reads both configured decks, enumerates every text box,
and reports per deck: missing placeholders, unrecognised `{{...}}` tokens, duplicate placeholders,
wrong slide count, and page size mismatch. Exits 0 when both decks conform, 1 otherwise.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- Client unit tests pass against a fake transport: `npx vitest run src/lib/visuals/`
- Validator reports every seeded defect on fixture deck payloads: `npx vitest run src/worker/validate-decks.test.ts`

#### Manual Verification:

- Service account created, JSON key issued, `GOOGLE_SA_PRIVATE_KEY_B64` populated
- Operator has built both decks per `template-spec.md` and shared them with the service account as Editor
- `npm run visuals:validate` exits 0 against the real decks

---

## Phase 3: Slot mapping and text fitting

### Overview

The pure, network-free core: turn a `generated_copy` row into a slot map, and decide the title's
font size. Every branch here is unit-testable with no Google account involved.

### Changes Required:

#### 1. Slot mapping

**File**: `src/lib/visuals/slots.ts`

**Intent**: Map one story's copy onto the placeholder vocabulary, taking the first three statistics
and rejecting a row that cannot fill the template.

**Contract**: `buildSlotMap(copy: GeneratedCopyRow): VisualResult<Record<string, string>>`. Reads
`key_statistics` as an array of `{label, value}`, takes the first three, and fails with a
diagnostic if fewer than three exist — the template has three fixed slots and Slides cannot hide an
element, so an empty slot would render as a blank pill. Cover slots are built separately from the
digest window.

#### 2. Title fitting

**File**: `src/lib/visuals/fit.ts`

**Intent**: Replace the autofit Slides won't apply through the API with a deterministic step-down,
and fail loudly past the last tier.

**Contract**: `fitTitle(title: string): VisualResult<number>` returning a point size from an
exported, ordered `TITLE_SIZE_TIERS` table (character-count ceiling → point size). Past the final
tier it fails with `title_too_long` and the measured length, so the operator sees a number rather
than a shrug. The table is exported so Phase 7 can recalibrate it against real generated titles
without touching call sites.

### Success Criteria:

#### Automated Verification:

- Slot mapping covers 3, 4 and 5 statistics, and fails on 2: `npx vitest run src/lib/visuals/slots.test.ts`
- Fitting covers every tier boundary on both sides plus the overflow failure: `npx vitest run src/lib/visuals/fit.test.ts`
- Linting passes: `npm run lint`

#### Manual Verification:

- Tier boundaries are sanity-checked against the four real titles in digest `c92aa3c5`'s `generated_copy` rows — none should land on the failure tier

---

## Phase 4: Render orchestrator

### Overview

Compose the stage: read the selection and copy, drive the deck, store the images, persist the rows,
clean up, checkpoint, transition.

### Changes Required:

#### 1. Storage upload

**File**: `src/lib/visuals/store.ts`

**Intent**: Download the short-lived thumbnail and re-host it durably before the URL expires.

**Contract**: `uploadAsset(client, bucket, path, bytes)` wrapping Supabase Storage's `upload` with
`contentType: "image/png"` and `upsert: true` so a retry overwrites rather than colliding. Path
shape `${digestId}/${slideIndex}.png`.

#### 2. Orchestrator

**File**: `src/lib/visuals/render.ts`

**Intent**: The stage proper, mirroring `generateDigest()`'s structure and its failure taxonomy.

**Contract**: `renderDigest(slides, storage, client, digest, options): Promise<RunStateResult<RenderOutcome>>`.

Sequence: sweep leftover duplicate pages → read `selection.format` and `generated_copy` rows →
build the page plan (single post: one page per story; carousel: cover plus one page per story) →
per page, duplicate the template slide, resolve placeholder object ids, `updateTextStyle` the
title, `replaceAllText` scoped to that page → `getPageThumbnail` → download → upload → collect the
row → delete duplicated pages → clear existing `generated_asset` rows for the digest → insert →
`markStageComplete(…, "rendering")` → transition to `ready_for_approval`.

Failure posture, matching the stage convention: an infrastructure error (Postgres, Storage) returns
raw; a genuine failure (no copy rows, a story that fails both attempts, a title past the last fit
tier, an unconfigured Slides client) transitions to `failed` with a diagnostic and returns
`ok: true`. Each story gets exactly one automatic retry before it counts as failed — the same
corrective-retry shape as `generateStory` and `clusterArticles`.

Page cleanup runs in a `finally`, so a mid-run failure does not leave the operator's deck dirty.

### Success Criteria:

#### Automated Verification:

- Happy path for both formats persists the expected row count: `npx vitest run src/lib/visuals/render.test.ts`
- A story failing once then succeeding yields a complete run; failing twice fails the digest
- Cleanup deletes every duplicated page on both the success and failure paths
- A digest with fewer than two `generated_copy` rows fails with a diagnostic, not a throw
- Full suite passes: `npm test`

#### Manual Verification:

- Reviewed that no code path can create a Drive file (only `duplicateObject` / `deleteObject` page operations)

---

## Phase 5: Worker entrypoint

### Overview

`npm run visuals`, shaped exactly like `npm run generate`.

### Changes Required:

#### 1. Entrypoint

**File**: `src/worker/visuals.ts`, `package.json` script

**Intent**: Resolve the target digest, refuse the wrong status, run the orchestrator, print a
human-readable summary.

**Contract**: `npm run visuals`, `--digest=<uuid>` targeting a specific digest, else the newest
digest in `rendering`. Exits 2 when refusing a digest not in `rendering`, mirroring
`src/worker/generate.ts`'s `GenerateRefused`. Re-running re-renders from scratch rather than
resuming. Never calls `process.exit` from the orchestrator.

#### 2. Generation hand-off — LANDED EARLY, IN PHASE 1

**File**: `src/lib/generation/generate.ts`

**Intent**: Point the generation stage at the new state.

**Contract**: The final `transitionDigest(client, digest.id, "ready_for_approval")` becomes
`"rendering"`. The `GenerateOutcome` shape is unchanged; `generate.test.ts` assertions on the
resulting status move with it.

**Moved to Phase 1 during implementation (operator-approved).** Phase 1 makes
`generating -> ready_for_approval` illegal, which immediately breaks four assertions
(`generate.test.ts:194,221,242` and `worker/generate.test.ts:211-213`) and makes `generateDigest()`
return `illegal_transition`. The state-machine change and this hand-off are one atomic change;
splitting them guaranteed a red suite across four phases. Progress row 5.2 was therefore satisfied
and flipped in Phase 1 and carries Phase 1's commit. Phase 5 still owns changes #1 (the entrypoint)
and #3 (`CLAUDE.md`).

#### 3. Documentation

**File**: `CLAUDE.md`

**Intent**: Record the new command and the runtime boundary, as every prior stage did.

**Contract**: A `npm run visuals` entry in the commands list and `src/lib/visuals/` named in the
pipeline-worker side of the two-runtimes section.

### Success Criteria:

#### Automated Verification:

- Flag parsing and refusal behaviour covered: `npx vitest run src/worker/visuals.test.ts`
- Generation now transitions to `rendering`: `npx vitest run src/lib/generation/generate.test.ts`
- Linting passes: `npm run lint`
- Full suite passes: `npm test`

#### Manual Verification:

- `npm run visuals` on a digest not in `rendering` refuses with a readable message and exit 2
- `npm run visuals --digest=<uuid>` targets that digest specifically

---

## Phase 6: Dashboard preview

### Overview

A read-only strip of rendered images on the digest page, so US-13 and US-14 are verifiable by
looking rather than by opening a storage bucket.

### Changes Required:

#### 1. Asset loading

**File**: `src/pages/dashboard/[id].astro`

**Intent**: Load this digest's assets and sign short-lived URLs for display.

**Contract**: Query `generated_asset` by `digest_id` ordered by `slide_index`; for each, call
`storage.from(bucket).createSignedUrl(path, ttl)`. A storage or query error renders a distinct
failure state, never an empty one — that was S-03 impl-review finding F2 and the same mistake is
available here.

#### 2. Presentation

**File**: `src/components/AssetStrip.astro`

**Intent**: Render the images in slide order, with the story each belongs to.

**Contract**: An Astro component (static, no interactivity) taking signed URLs plus slide index and
optional cluster title. Shown only for digests at or past `rendering`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- Digest page shows the rendered cards in slide order behind the PIN gate
- A digest with no assets yet renders cleanly rather than showing a broken strip
- A forced storage error renders the failure state, not an empty one

---

## Phase 7: Live verification

### Overview

The step S-03 and S-05 both learned they needed: prove it against the real Google account, the real
decks, and real generated copy, and let the operator judge the output.

### Changes Required:

#### 1. Live smoke test

**File**: `src/lib/visuals/slides.live.test.ts`

**Intent**: One opt-in test that catches a revoked service-account key, an unshared deck, or a
Slides API shape change — none of which a fake transport can.

**Contract**: `SLIDES_LIVE_SMOKE=1 npx vitest run src/lib/visuals/slides.live.test.ts` duplicates a
page in the real single-post deck, fills it with fixture text, exports it, asserts PNG bytes come
back, and deletes the page. Skips entirely when the flag is absent, matching
`EMAIL_LIVE_SMOKE` / `COLLECTION_LIVE_SMOKE`. Documented in `CLAUDE.md` alongside them.

#### 2. Real run and calibration

**File**: `src/lib/visuals/fit.ts` (tier table only), `context/changes/brand-visual-assets/verification.md`

**Intent**: Run the stage on a live digest, record the result, and correct the fit tiers against
titles that actually occurred.

**Contract**: A short record of the run — digest id, story count, asset count, any retries, and the
operator's verdict on whether the cards are publishable. Tier-table adjustments made here are the
only code change this phase may introduce.

### Success Criteria:

#### Automated Verification:

- `SLIDES_LIVE_SMOKE=1 npx vitest run src/lib/visuals/slides.live.test.ts` passes against the real decks
- Full suite still passes after any tier recalibration: `npm test`

#### Manual Verification:

- A live digest completes `rendering → ready_for_approval` with one asset per expected slide
- Operator confirms the rendered cards are publishable — correct branding, no clipped or shrunken text, Polish diacritics correct
- Operator edits a deck (a colour or position), re-runs, and confirms the change appears with no code change — US-13 demonstrated
- Both decks are left clean, with no leftover duplicated slides

---

## Testing Strategy

### Unit Tests:

- Slot mapping across 3/4/5 statistics and the under-three failure
- Fit tiers at every boundary, both sides, plus overflow failure
- Validator against fixture deck payloads seeded with each defect class
- Orchestrator against a fake Slides transport and a fake storage client: both formats, retry-then-succeed, retry-then-fail, cleanup on both paths, missing copy rows

### Integration Tests:

- State-machine drift guard (parses the new migration; fails if SQL and TS diverge)
- Generation stage now lands in `rendering`

### Manual Testing Steps:

1. `npm run visuals:validate` against the real decks — expect exit 0
2. `npm run generate` on a selected digest — expect it to land in `rendering`
3. `npm run visuals` — expect `ready_for_approval` and one asset per slide
4. Open the digest page — expect the cards in slide order
5. Edit a deck colour, re-run `npm run visuals`, confirm the change appears
6. Point the stage at a digest whose title exceeds the last fit tier — expect a clean `failed` with a readable diagnostic and a clean deck
7. Re-run after that failure — confirm `failed → rendering` recovers without re-running generation

## Performance Considerations

Rendering is 3-5 slides per week. Slides API quotas are far above that; there is nothing to
optimise. Pages are processed sequentially for the same reason `generateDigest` is: at this size
concurrency buys nothing and complicates the cleanup guarantee.

The stage costs no LLM spend, so it never touches the F-03 ceiling.

## Migration Notes

Two migrations, applied in filename order — the enum value must be committed before the trigger
that routes through it.

**Applied 2026-09-08** via the Supabase SQL Editor as two separate executions, and verified against
the live project: `generated_asset` reachable by the service role, `digest.rendering_completed_at`
present, the `digest-assets` bucket created with `public = false`, and the transition trigger
confirmed directly (bypassing the TypeScript guard) to reject `generating -> ready_for_approval`
with errcode 23514 while allowing `generating -> rendering`, `rendering -> ready_for_approval` and
`failed -> rendering`.

**The `supabase migration repair` debt was NOT cleared, and now stands at eight versions**:
`20260829120000`, `20260829130000`, `20260906140000`, `20260906141000`, `20260906150000`,
`20260908120000`, `20260908130000`, `20260908140000` — all applied by hand and absent from
`supabase_migrations.schema_migrations`. It could not be cleared from the current dev machine:
`supabase migration list` and `--db-url` against the session pooler both fail with
`LegacyDbConnectError: Connection timed out`, and the direct host `db.<ref>.supabase.co` no longer
resolves at all. TCP to the pooler on 5432 and 6543 is open, so this is a Postgres-handshake or
routing problem, not a firewall one. This is the same constraint already recorded in
`src/db/database.types.ts:4-5` and is why every migration in this project has been applied by hand.
Clearing it needs a machine that can complete a Postgres connection to the project.

Digests already sitting in `ready_for_approval` predate this stage and have no assets. The preview
renders them as an empty strip rather than an error, and no backfill is attempted.

## References

- Roadmap slice: `context/foundation/roadmap.md` (S-06), Open Questions #2 and #3 — both closed by this plan
- PRD: FR-015, US-13, US-14
- Upstream contract: `supabase/migrations/20260906150000_generated_copy.sql`
- Stage pattern to mirror: `src/lib/generation/generate.ts`, `src/worker/generate.ts`
- Drift guard: `src/lib/digest/state-machine.test.ts:15-54`
- Prior review lessons: `context/archive/2026-09-06-polish-copy-generation/reviews/impl-review.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema, state, and storage bucket

#### Automated

- [x] 1.1 Type checking passes: `npm run build` — 1fb6a9c
- [x] 1.2 Linting passes: `npm run lint` — 1fb6a9c
- [x] 1.3 State-machine drift guard passes — 1fb6a9c
- [x] 1.4 Full suite passes: `npm test` — 1fb6a9c

#### Manual

- [x] 1.5 Both migrations applied; migration-repair debt cleared or re-recorded — 1fb6a9c
- [x] 1.6 `digest-assets` bucket exists and is private — 1fb6a9c
- [x] 1.7 `generating → rendering → ready_for_approval` works by hand; the old direct move is rejected — 1fb6a9c

### Phase 2: Slides client, template spec, and validator

#### Automated

- [x] 2.1 Type checking passes: `npm run build` — 89e8855
- [x] 2.2 Linting passes: `npm run lint` — 89e8855
- [x] 2.3 Client unit tests pass against a fake transport — 89e8855
- [x] 2.4 Validator reports every seeded defect on fixture payloads — 89e8855

#### Manual

- [ ] 2.5 Service account created and key configured
- [ ] 2.6 Operator has built both decks and shared them as Editor
- [ ] 2.7 `npm run visuals:validate` exits 0 against the real decks

### Phase 3: Slot mapping and text fitting

#### Automated

- [x] 3.1 Slot mapping covers 3/4/5 statistics and fails on 2 — 4c9a252
- [x] 3.2 Fitting covers every tier boundary plus the overflow failure — 4c9a252
- [x] 3.3 Linting passes: `npm run lint` — 4c9a252

#### Manual

- [x] 3.4 Tier boundaries sanity-checked against digest `c92aa3c5`'s real titles — 4c9a252

### Phase 4: Render orchestrator

#### Automated

- [x] 4.1 Happy path for both formats persists the expected row count — e0609c4
- [x] 4.2 Retry-then-succeed completes; retry-then-fail fails the digest — e0609c4
- [x] 4.3 Cleanup deletes every duplicated page on success and failure paths — e0609c4
- [x] 4.4 Too few copy rows fails with a diagnostic, not a throw — e0609c4
- [x] 4.5 Full suite passes: `npm test` — e0609c4

#### Manual

- [x] 4.6 Reviewed that no code path can create a Drive file — e0609c4

### Phase 5: Worker entrypoint

#### Automated

- [x] 5.1 Flag parsing and refusal behaviour covered — cb8f31b
- [x] 5.2 Generation now transitions to `rendering` — 1fb6a9c
- [x] 5.3 Linting passes: `npm run lint` — cb8f31b
- [x] 5.4 Full suite passes: `npm test` — cb8f31b

#### Manual

- [x] 5.5 Wrong-status digest refused with a readable message and exit 2 — cb8f31b
- [x] 5.6 `--digest=<uuid>` targets that digest specifically — cb8f31b

### Phase 6: Dashboard preview

#### Automated

- [x] 6.1 Type checking passes: `npm run build`
- [x] 6.2 Linting passes: `npm run lint`

#### Manual

- [x] 6.3 Digest page shows rendered cards in slide order behind the PIN gate
- [x] 6.4 A digest with no assets renders cleanly
- [x] 6.5 A forced storage error renders the failure state, not an empty one

### Phase 7: Live verification

#### Automated

- [ ] 7.1 `SLIDES_LIVE_SMOKE=1` smoke test passes against the real decks
- [ ] 7.2 Full suite still passes after tier recalibration

#### Manual

- [ ] 7.3 A live digest completes `rendering → ready_for_approval` with the expected asset count
- [ ] 7.4 Operator confirms the cards are publishable
- [ ] 7.5 Operator demonstrates US-13: deck edit changes output with no code change
- [ ] 7.6 Both decks left clean, no leftover duplicated slides
