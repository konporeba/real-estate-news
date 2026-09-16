# Scheduled Publishing (S-08) Implementation Plan

## Overview

S-08 is the last stage of the publish loop (Stream C): once a digest is `approved` (or `skipped` past its deadline, per US-19), its generated copy and rendered visuals get posted to the operator's selected platforms — Instagram, Facebook, LinkedIn — either automatically at Tuesday 17:00 `Europe/Warsaw` or manually from the dashboard at any later time. Per-platform success and failure are recorded independently (US-20): one platform failing must never block, retry, or hide the others.

This plan builds the Instagram/Facebook/LinkedIn integrations **from scratch** against each platform's real API. This is a deliberate departure from the PRD, which lists reusing a prior project's validated integration as the approach and rebuilding it as a **Non-Goal** — confirmed explicitly during planning because the prior integration's code isn't available to hand over. Phase 6 reconciles the PRD/roadmap wording with this decision.

## Current State Analysis

- The digest state machine (`src/lib/digest/state-machine.ts`) already has the transitions this slice needs: `approved → published`, `skipped → published`. No new digest states and no changes to `enforce_digest_transition()` are required.
- `generated_asset`'s migration (`20260908140000_visual_assets.sql`) explicitly deferred a `publication` table to this slice: *"which asset went where is S-08's `publication` table to record, not this one."*
- The operator's confirmed `selection` row (`selection` table, S-04) already stores `format` (`single_post`/`carousel`) and `platforms` (`selection_platform[]`, one of `instagram`/`linkedin`/`facebook`) — this is the target list for publishing, already validated at selection time.
- `generated_copy` (S-05) has one row per selected story with `caption_summary` (explicitly "caption-ready") — the source material for the post's caption text. `body_copy` and `key_statistics` are not needed here; they were already baked into the rendered images.
- `generated_asset` (S-06) has one row per rendered slide (`slide_index` order, cover slide first for a carousel, `cluster_id` nullable for the cover), stored as a private-bucket `storage_path` — not a URL. The approve page (`src/pages/dashboard/[id]/approve.astro`) already mints short-lived signed URLs from this bucket via `createSignedUrls`; the publish path needs the same technique to hand Meta's Graph API a fetchable image URL.
- No `publication` table, no publisher client code, and no platform credentials exist anywhere in this repo today — this is greenfield within the codebase, built against the established harness/worker/scheduler conventions from F-03/F-04/F-05/S-06/S-07.
- The scheduler registry (`src/lib/scheduler/registry.ts`) already anticipates this: its own comment says *"S-08 will add a third entry, 'publish', the same way"* S-07 added `approval-reminder`.
- The approve page and `ApprovalPanel`/`useApproval` (S-07) are the direct UI/API precedent for the manual publish action: a hydrated island, a two-step confirm dialog, a dedicated API route that does almost nothing beyond auth + validation + one RPC call, mapped SQLSTATEs.

### Key Discoveries:

- `record_approval()` (`supabase/migrations/20260912100000_approval_record.sql`) is the exact atomic-RPC template to follow: `FOR UPDATE` row lock, distinct SQLSTATEs (`AG00x`) mapped by the API route on `error.code`, `SECURITY DEFINER`, RLS-deny-by-default with `grant execute ... to service_role` only.
- Every harness in this codebase (`createLlmClient`, `createEmailClient`, future Slides client) returns `null` when unconfigured rather than throwing, and the caller decides what to do — `src/lib/publishing`'s platform clients follow the same shape.
- Shared modules that must work from both runtimes take their Supabase client as a parameter and read no environment of their own — e.g. `src/lib/digest/run-state.ts`'s `createDigest(client: ServiceClient, window: DigestWindow)`. `src/lib/publishing/` follows the same rule: the orchestration and platform-client modules take credentials and a `ServiceClient` as parameters, never importing `astro:env/server` or `process.env` directly — that stays confined to `src/worker/env.ts` (worker) and `astro.config.mjs`'s `env.schema` + a new `src/lib/publishing-admin.ts` (app), mirroring `supabase-service.ts`/`supabase-admin.ts`'s split exactly.
- Instagram and Facebook (Meta Graph API) both require a **container-then-publish** flow, not a single call: media (an image, or an assembled carousel of images) is first registered as an unpublished container, then a second call actually publishes it. LinkedIn similarly requires registering each image via its Images API (an upload URL is returned, image bytes are `PUT` there) before referencing the resulting image URN in the post. All three platforms share this two-step "register media, then create the post" shape.

## Desired End State

An `approved` (or `skipped`) digest publishes to every platform the operator selected, either automatically at Tuesday 17:00 `Europe/Warsaw` (`npm run publish` via the scheduler) or manually from the approve page. Each platform's outcome (success + post id, or failure + error) is recorded independently in a new `publication` table; a platform that already succeeded is never re-posted to on a later retry. The digest moves to `published` the first time any platform succeeds, and stays exactly where it was (`approved`/`skipped`) if every platform fails, so nothing is lost and a retry is always available. The PRD and roadmap Non-Goals/reuse language reflect that this integration was actually built new, not reused.

Verification: run `npm run publish -- --digest=<a real approved digest>` against your actual Meta and LinkedIn accounts before the first unattended Tuesday fire, and confirm three real posts (or three real, clearly-attributed failures) show up.

## What We're NOT Doing

- Not building S-09's archive/learning-loop consumption of publication results (browsing history, few-shot feedback) — that's the next roadmap slice.
- Not building S-10's heartbeat/alerting for a digest stuck unpublished after a total failure — out of scope for this slice; the digest simply stays `approved`/`skipped` and remains manually retriable.
- Not adding automatic retry/backoff within a single publish run — one attempt per platform per run, matching `sendEmail()`'s "no retry, fail fast" contract. Retries happen via re-running the job (scheduled or manual), which already skips anything that already succeeded.
- Not building a live, opt-in smoke test that posts to real accounts (unlike `SLIDES_LIVE_SMOKE`/`EMAIL_LIVE_SMOKE`) — a real post is publicly visible on business accounts, which is a materially different risk than a private Slides doc or a self-addressed email. Verification against real accounts is a one-time manual dry run (Phase 6), not a repeatable opt-in suite.
- Not building a token-refresh/rotation system for Meta's or LinkedIn's expiring access tokens — credentials are operator-managed `.env` values, exactly like every other integration in this repo (Gmail App Password, Google service-account key).
- Not adding a `platform` column to `generated_asset` or any per-platform image variant — one rendered image set (per S-06) is posted identically to every selected platform, matching that table's existing design note.

## Implementation Approach

Follow this repo's established shape end to end: a schema migration + one atomic RPC (mirrors `record_approval`), runtime-neutral shared logic in `src/lib/publishing/` (mirrors `src/lib/approval/`, `src/lib/digest/`), a worker entrypoint (`src/worker/publish.ts`, mirrors `visuals.ts`), scheduler wiring (mirrors `approval-reminder`), and a dashboard island + API route (mirrors `ApprovalPanel`/`useApproval`/`decide.ts`). The one genuinely new piece is the platform-client code itself (Phase 2), since nothing like it exists in this codebase yet.

The orchestrator (`runPublish`) is the single source of truth for "which platforms still need publishing" — both the scheduled worker and the manual dashboard trigger call it, so "skip already-succeeded platforms" is enforced in exactly one place regardless of which path invoked it.

## Critical Implementation Details

**Platform API specifics may have shifted by implementation time.** Meta's Graph API version and LinkedIn's API surface both change on their own schedule; the container-then-publish shape and Images-API-then-post shape described here are the current, well-established mechanisms, but exact field names should be re-confirmed against each platform's current developer docs during Phase 2, the same way F-03 discovered the real Anthropic `usage` shape only by implementing against it. This is an ordinary external-integration risk, not an open design question — Phase 6's manual dry run is what actually proves the real contract.

**LinkedIn organization-page posting may require its own access approval.** Posting to a Company Page via LinkedIn's API generally requires the Community Management API product, which is an application/review process with its own external lead time — structurally the same kind of dependency as S-06's Canva access request (that slice's Open Question #2). File this request as early as possible, the same way OQ#2 was; do not wait until Phase 6's dry run to discover it's needed.

**Caption length limits are per-platform, not universal.** Instagram enforces a ~2,200-character caption limit; LinkedIn's organization-post commentary has its own (larger) limit; Facebook's is effectively unbounded for this use case. The composed caption (Phase 2) must be truncated to each target platform's own limit before that platform's post call, not to one shared constant — a 4-story carousel caption assembled from four `caption_summary` fields can plausibly exceed Instagram's limit even though it fits LinkedIn's.

## Phase 1: Schema & publication record

### Overview

Add the `publication` table and the atomic `record_publication` RPC that writes one platform's outcome and conditionally moves the digest to `published`. No changes to the digest transition trigger are needed — `approved → published` and `skipped → published` already exist.

### Changes Required:

#### 1. `publication` table + `record_publication` RPC

**File**: `supabase/migrations/20260913120000_publication.sql`

**Intent**: Durable, per-platform record of a publish attempt's outcome (US-20's "per-platform success/failure recorded independently"), written atomically alongside the digest's conditional transition to `published`.

**Contract**:
- `create type publication_status as enum ('success', 'failure')`.
- `publication(id, digest_id references digest, platform selection_platform, status publication_status, post_id text, error text, published_at timestamptz default now(), created_at timestamptz default now())`, `unique (digest_id, platform)` — reuses the existing `selection_platform` enum rather than defining a new one, exactly as `generated_asset.format` reuses `selection_format`.
- RLS enabled, deny-by-default, no policies — same posture as every other domain table (`approval`, `generated_asset`, `generated_copy`).
- `record_publication(p_digest_id uuid, p_platform selection_platform, p_status publication_status, p_post_id text, p_error text) returns uuid`, `security definer`, following `record_approval`'s exact shape:
  - `select status into v_status from digest where id = p_digest_id for update` — raises `PB001` if not found.
  - Raises `PB002` if `v_status not in ('approved', 'skipped', 'published')` — a retry after the digest is already `published` (some platforms still pending) is legal; anything else is not.
  - `insert into publication (...) on conflict (digest_id, platform) do update set status = excluded.status, post_id = excluded.post_id, error = excluded.error, published_at = excluded.published_at` — a retry overwrites the prior attempt's record for that platform rather than accumulating rows, mirroring `generated_asset`'s "re-running deletes and rewrites" precedent adapted to an upsert (there is exactly one current-truth row per platform, not a history of past attempts).
  - If `p_status = 'success'` and `v_status in ('approved', 'skipped')`: `update digest set status = 'published'`.
  - Grants: `revoke ... from public, anon, authenticated`, `grant execute ... to service_role` only.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes
- Migration applies cleanly against local Supabase: `npx supabase db reset` (or `db push` against a scratch project)
- New unit test asserting `record_publication`'s SQLSTATEs and the conditional transition, mirroring `state-machine.test.ts`'s style of exercising the RPC against a real (test-project) digest

#### Manual Verification:

- Inspect the applied schema in the Supabase dashboard: `publication` table exists, RLS enabled, no policies, `record_publication` grants show only `service_role`

---

## Phase 2: Platform publisher clients

### Overview

One module per platform (`src/lib/publishing/{instagram,facebook,linkedin}.ts`), each built against that platform's real posting API, sharing a common `Publisher` interface. Includes signed-URL image handoff and per-platform caption composition/truncation.

### Changes Required:

#### 1. Shared publisher contract

**File**: `src/lib/publishing/types.ts`

**Intent**: One interface every platform client implements, so the orchestrator (Phase 3) never branches on which platform it's calling.

**Contract**: `interface Publisher { publish(images: readonly string[], caption: string): Promise<PublishAttempt> }` where `PublishAttempt = { ok: true; postId: string } | { ok: false; error: string }`. `images` are already-signed, fetchable URLs in publish order (cover first for a carousel); `caption` is already composed and truncated for that platform.

#### 2. Caption composition

**File**: `src/lib/publishing/caption.ts`

**Intent**: Build the one caption a multi-story post needs from each selected story's `caption_summary`, and enforce each platform's own length limit.

**Contract**: `composeCaption(summaries: readonly string[]): string` joins already-ordered summaries with a clear separator (e.g. a blank line plus a divider) — no LLM call, no new cost, reusing `generated_copy.caption_summary` verbatim per the confirmed decision. `truncateForPlatform(caption: string, maxLength: number): string` truncates with a trailing ellipsis if over the limit; each platform module exports its own `MAX_CAPTION_LENGTH` (Instagram ~2200, LinkedIn per its current org-post limit, Facebook effectively unbounded here) and applies it before calling its own API.

Neither `generated_copy` nor `selection_item` carries an explicit rank column (`src/lib/generation/generate.ts` itself reads picked clusters with no `ORDER BY`), so "shortlist/selection order" is not a query this module — or the orchestrator calling it — can express directly. Order is instead derived downstream from `generated_asset.slide_index`, which S-06 already fixed deterministically at render time (cover slide first, then one slide per story) — see Phase 3's "images and captions" step below. `composeCaption` itself takes already-ordered input; it does not query anything or decide the order.

#### 3. Instagram publisher

**File**: `src/lib/publishing/instagram.ts`

**Intent**: Post the rendered images (single image, or a carousel of 2+ slides) to the operator's Instagram Business account via the Meta Graph API.

**Contract**: `createInstagramPublisher(credentials: { accessToken: string; igUserId: string } | null): Publisher | null` — `null` in, `null` out (unconfigured), mirroring `createEmailClient`/`createLlmClient`. Internally: for a single image, create one media container (`image_url` + `caption`) then publish it; for a carousel, create one child container per image (`is_carousel_item: true`), then one parent container (`media_type: CAROUSEL`, `children`, `caption`), then publish the parent. Returns the published media id as `postId`, or the Graph API's error message as `error`.

Container creation is asynchronous on Meta's side — a container's `status_code` starts `IN_PROGRESS` and must reach `FINISHED` before `/media_publish` will succeed (a premature publish call fails with error code 9007). Before publishing any container (child, parent, or the single-image container), poll `GET /{container-id}?fields=status_code` with a short bounded backoff (e.g. up to ~10 attempts); treat `ERROR` or exhausting the polling budget as a publish failure for that platform, not a crash.

#### 4. Facebook publisher

**File**: `src/lib/publishing/facebook.ts`

**Intent**: Post the same rendered images to the operator's Facebook Page.

**Contract**: `createFacebookPublisher(credentials: { accessToken: string; pageId: string } | null): Publisher | null`. Internally: upload each image as an unpublished Page photo to get photo ids, then create one Page feed post referencing all of them (`attached_media`) with the composed caption as the message. A single image still uses the same two-step shape for consistency, even though Facebook's single-photo endpoint could post directly — one code path per platform, not a single-vs-carousel branch inside this module.

#### 5. LinkedIn publisher

**File**: `src/lib/publishing/linkedin.ts`

**Intent**: Post the same rendered images to the operator's LinkedIn Company Page.

**Contract**: `createLinkedinPublisher(credentials: { accessToken: string; organizationUrn: string } | null): Publisher | null`. Internally: register each image via LinkedIn's Images API (initialize upload, `PUT` the image bytes to the returned upload URL, keep the resulting image URN), then create one post (`author` = the organization URN, `commentary` = the composed caption, a multi-image content block referencing the URNs).

#### 6. Signed image URLs for the publish path

**File**: `src/lib/publishing/assets.ts`

**Intent**: Give the publisher modules fetchable URLs for images that live in the private `digest-assets` bucket, since all three platforms' APIs need a URL (or upload) they can reach, not a Supabase Storage path.

**Contract**: `signAssetUrls(client: ServiceClient, storagePaths: readonly string[]): Promise<Map<string, string>>` wraps `client.storage.from(ASSET_BUCKET).createSignedUrls(...)`, reusing `ASSET_BUCKET` from `src/lib/digest/assets.ts`. Note that `SIGNED_URL_TTL_SECONDS` (600s) is documented there as sized for "the browser fetching images on a page it just loaded" — a different consumer than Meta's servers fetching a URL asynchronously after the API call returns. Reuse the same constant, but pass a longer, locally-defined TTL for this module specifically (e.g. `PUBLISH_SIGNED_URL_TTL_SECONDS`, a few times larger) rather than assuming the browser-page rationale still holds; Phase 6's dry run is what confirms whether the default would have been enough.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes
- `npx vitest run src/lib/publishing/` passes — each platform client tested against faked `fetch` responses (success, and a representative API error shape), mirroring how `rss.test.ts` fakes feed responses and `slides.live.test.ts`'s non-live sibling fakes the Slides API; Instagram's tests additionally cover an `IN_PROGRESS` → `FINISHED` polling sequence and an exhausted-polling-budget failure
- Caption composition/truncation unit tests cover: 1 story, 4 stories under the limit, 4 stories over the limit (truncated correctly per platform)

#### Manual Verification:

- None yet — real-account verification is Phase 6's dry run, after the orchestrator (Phase 3) can actually be invoked end-to-end

---

## Phase 3: Publish orchestration

### Overview

`runPublish` is the one function both the scheduled worker and the manual dashboard trigger call: given a digest, it figures out which selected platforms still need publishing, gathers the caption/images, calls each pending platform once, and records every outcome.

### Changes Required:

#### 1. Orchestrator

**File**: `src/lib/publishing/run.ts`

**Intent**: The single place "which platforms are pending" and "attempt once, record, move on" are decided — so the scheduled job and the manual retrigger can never disagree about whether a platform was already published.

**Contract**: `runPublish(client: ServiceClient, digestId: string, publishers: Partial<Record<SelectionPlatform, Publisher>>): Promise<PublicationResult<PublishSummary>>` where `PublishSummary` lists every platform attempted this call with its outcome. Steps: read the digest's current status (must be `approved`, `skipped`, or `published`, else a `wrong_status` error mirroring `ApprovalErrorReason`'s idiom); read `selection.platforms`; read existing `publication` rows and subtract any already `success` from the target list — the resulting set is what gets attempted; if empty, return ok with an empty summary (nothing pending).

**Images and captions, in one consistent order**: query `generated_asset` for the digest ordered by `slide_index` ascending (the same query `approve.astro` already runs: `.eq("digest_id", digestId).order("slide_index")`) to get the images in render order (cover slide first, `cluster_id` null on the cover). Separately fetch `generated_copy` rows for the digest and index them by `cluster_id`. Build the ordered caption-summary list by walking the `generated_asset` rows in slide order and, for each row with a non-null `cluster_id`, looking up that cluster's `caption_summary` — this guarantees the caption text lists stories in exactly the order the images show them, since both derive from the same `slide_index` sequence rather than two independently-ordered queries.

For each pending platform: if `publishers[platform]` is `null`/absent, record `{ ok: false, error: "not_configured" }` (mirrors the harness idiom — no distinct DB status value needed, the error text says why); otherwise call `publisher.publish(images, caption)` once (no retry) and record the result. Every recorded outcome goes through `record_publication`, whose own conditional logic handles moving the digest to `published` — this function does not transition the digest itself.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes
- `npx vitest run src/lib/publishing/run.test.ts` passes, covering: all platforms succeed; one succeeds and one fails (US-20); a re-run after a partial failure only re-attempts the failed platform; a digest already fully published returns an empty summary; an unconfigured platform records `not_configured` without throwing; caption order matches image order when `generated_copy` rows are returned in a different order than `generated_asset`'s `slide_index` sequence
- Integration test (opt-in, `SUPABASE_TEST_PROJECT=1`) exercising `record_publication` against the real test project, mirroring the existing approval/selection integration suites

#### Manual Verification:

- None yet — covered by Phase 6

---

## Phase 4: Worker entrypoint + scheduler wiring

### Overview

`npm run publish` (the manual/scheduled entrypoint) and its Tuesday 17:00 `Europe/Warsaw` automatic fire, following `visuals.ts`'s and `approval-reminder`'s exact precedents.

### Changes Required:

#### 1. Publishing credentials in the worker environment

**File**: `src/worker/env.ts`

**Intent**: Load the three platforms' credentials the same optional way Slides/Gmail credentials are loaded — a worker with none of these configured still runs every other stage fine; only `npm run publish` needs them.

**Contract**: Add `META_ACCESS_TOKEN`, `META_PAGE_ID`, `META_IG_USER_ID`, `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORGANIZATION_URN` to `workerEnvSchema`, all `.optional()`, following the exact style of the `GOOGLE_SA_*`/`SLIDES_DECK_*` block.

#### 2. Worker entrypoint

**File**: `src/worker/publish.ts`

**Intent**: The `npm run publish` CLI entrypoint, mirroring `visuals.ts`'s target-resolution shape.

**Contract**: `main(): Promise<number>`. Targets, in order: `--digest=<uuid>` if given (re-attempts that digest, including a retry after some platforms already succeeded); else the newest digest in `approved` or `skipped` with at least one platform still pending. Exits 2 when no eligible digest is found. Builds `publishers` from `loadWorkerEnv()` via `createInstagramPublisher`/`createFacebookPublisher`/`createLinkedinPublisher` (each `null` if its own credentials are absent) and calls `runPublish`. Logs a per-platform outcome line, matching `visuals.ts`'s per-slide logging style.

#### 3. `package.json` script

**File**: `package.json`

**Intent**: Expose the worker entrypoint as `npm run publish`, matching every other stage's script.

**Contract**: `"publish": "tsx --env-file=.env src/worker/publish.ts"` (or the project's existing exact invocation pattern for `visuals`/`generate`/`rank` — copy that pattern verbatim).

#### 4. Scheduled job registration

**File**: `src/lib/scheduler/registry.ts`

**Intent**: Register the Tuesday 17:00 `Europe/Warsaw` automatic fire, exactly as the registry's own comment anticipates.

**Contract**: Add `{ name: "publish", schedule: { dayOfWeek: 2, hour: 17, minute: 0 } }` to `SCHEDULED_JOBS` (`dayOfWeek` 2 = Tuesday, following the existing 0=Sunday/1=Monday convention already documented in this file).

#### 5. Scheduled job action

**File**: `src/worker/scheduled-run.ts`

**Intent**: Wire the "publish" job name to `publish.ts`'s `main()`, mirroring `runApprovalReminderJob`'s thin wrapper around `remind.ts`.

**Contract**: `runPublishJob(): Promise<JobOutcome>` calls `runPublish`'s worker entrypoint and maps its exit code the same way `runApprovalReminderJob` does; added to the `JOB_ACTIONS` record under `"publish"`.

#### 6. `.env.example`

**File**: `.env.example`

**Intent**: Document the new credentials for the operator, in this file's existing per-integration comment-block style (see the `S-06: Google Slides` block for the pattern to match).

**Contract**: A new block naming what each of the five variables is, where to obtain it (Meta Business Suite / Graph API Explorer for the access token, Page and connected IG Business account ids; LinkedIn Developer Portal for the org's access token and URN), and that all are optional until `npm run publish` is actually used.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes
- `npx vitest run src/worker/publish.test.ts` passes, covering target resolution (`--digest`, newest-eligible fallback, exit 2 on none) with a faked `runPublish`
- `npx vitest run src/worker/scheduled-run.test.ts` passes with the new `"publish"` action included in its fake-action test matrix

#### Manual Verification:

- `npm run publish -- --digest=<a real approved digest, credentials unset>` reports every platform as `not_configured` and exits cleanly rather than crashing

---

## Phase 5: Manual publish dashboard action

### Overview

A "Publish now" action on the approve page for a digest that's `approved` or `skipped` (FR-023's "operator can publish manually from the dashboard at any later time"), reusing the same orchestrator the scheduled job calls.

### Changes Required:

#### 1. Publishing credentials for the Astro app

**File**: `astro.config.mjs`

**Intent**: Let the manual-publish API route build the same publisher clients the worker does, from `astro:env/server` instead of `process.env`.

**Contract**: Add the same five variables from Phase 4 to `env.schema`, each `envField.string({ context: "server", access: "secret", optional: true })`, matching the existing `SUPABASE_SERVICE_ROLE_KEY`/`PIN_HASH` entries' shape.

#### 2. App-side credential loader

**File**: `src/lib/publishing-admin.ts`

**Intent**: The Astro-side twin of `supabase-admin.ts` — reads `astro:env/server` and hands the same credential shape Phase 2's publisher factories expect, so the API route and the worker build identical `Publisher` instances from different environments.

**Contract**: Exports one function per platform (or one function returning all three credential objects) reading from `astro:env/server`; never imported from `src/worker/*` (the two-runtime boundary already forbids that direction).

#### 3. Manual publish API route

**File**: `src/pages/api/publish/trigger.ts`

**Intent**: The HTTP entrypoint for "Publish now" — auth, build publishers, call `runPublish`, map its result to JSON. Mirrors `src/pages/api/approval/decide.ts`'s shape almost exactly.

**Contract**: `POST`, `prerender = false`. Requires `context.locals.operatorAuthenticated` (401 otherwise, checked before any body parsing). Body: `{ digestId: string }`. Calls `runPublish` with app-sourced publishers; maps its `PublicationErrorReason` onto HTTP status/JSON the same way `decide.ts` maps `ApprovalErrorReason`. Returns `{ ok: true, summary }` on success (`summary` is the same `PublishSummary` Phase 3 defined) so the island can render per-platform results without a second fetch.

#### 4. Publish panel island

**File**: `src/components/PublishPanel.tsx` + `src/components/hooks/usePublish.ts`

**Intent**: The two-step-confirm "Publish now" affordance, mirroring `ApprovalPanel`/`useApproval` exactly — a one-way action (posting to real accounts) gets the same review-then-confirm dialog as approve/reject.

**Contract**: `usePublish(digestId)` mirrors `useApproval`'s `{ reviewing, startReview, cancelReview, submit, confirm }` shape, POSTing to `/api/publish/trigger` instead of `/api/approval/decide`. `PublishPanel` renders the button + confirm dialog, then the per-platform result pills (success with a link if the platform's post is linkable, or failure with its error) once `submit` resolves — reusing `PLATFORM_LABELS` from `src/lib/selection/rules.ts`.

#### 5. Approve page wiring

**File**: `src/pages/dashboard/[id]/approve.astro`

**Intent**: Show the publish panel once there's something to publish, and show existing `publication` results (from a prior scheduled or manual attempt) even without re-triggering.

**Contract**: Extend the page's status handling to also load and render for `approved`/`skipped` (currently the post-decision branch only reads `approval`; add a `publication` row query the same way the `approval` query is added conditionally on status). Render `PublishPanel` when `digest.status` is `approved` or `skipped`; render existing per-platform results (from the `publication` table) whenever any rows exist, regardless of status — a `published` digest still shows what happened.

#### 6. Digest detail page navigation to the publish path

**File**: `src/pages/dashboard/[id].astro`

**Intent**: The main digest page is where the operator actually lands first (from the digest list), and it already has a status-driven conditional pointing to `/approve` — but only for `ready_for_approval`/`approved`/`rejected` (lines ~299–313). Without this fix, a `skipped` digest (which needs the manual "Publish now" action) and a `published` digest (whose per-platform results now live on `/approve`) have no link there at all, leaving Phase 5's entire UI unreachable from normal navigation for exactly the two statuses it's built for.

**Contract**: Extend the existing `digest.status === "approved" || digest.status === "rejected"` branch (and its neighboring `ready_for_approval` branch) to also match `"skipped"` and `"published"`, linking to `/dashboard/${digest.id}/approve` with copy appropriate to each status (e.g. "This digest is ready to publish manually →" for `skipped`, "This digest was published — view results →" for `published`).

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes
- `npx astro check` passes (page/component type-checking)
- Component/unit tests for `usePublish` mirroring `useApproval`'s existing test coverage, if one exists, or a new equivalent

#### Manual Verification:

- On a real `approved` test digest with all platform credentials unset, click "Publish now", confirm, and see all three platforms reported as `not_configured` in the UI without a crash or an unhandled error state
- Reloading the approve page for a digest with existing `publication` rows shows those results without needing to click "Publish now" again
- Visiting `/dashboard/<id>` (not `/approve` directly) for a `skipped` digest shows a link to the publish action, and for a `published` digest shows a link to the results

---

## Phase 6: Docs reconciliation + live dry run

### Overview

Bring the PRD and roadmap in line with the "built from scratch" decision, and prove the real integration works against your actual accounts before the first unattended Tuesday fire.

### Changes Required:

#### 1. PRD Non-Goals

**File**: `context/foundation/prd.md`

**Intent**: The Non-Goals section currently states the social publishing integration is "reused from the prior project, already validated across all three platforms" (and the Vision & Problem Statement makes the same claim) — no longer accurate once this plan ships.

**Contract**: Replace the Non-Goals bullet and the Vision section's equivalent claim with language reflecting that Instagram/Facebook/LinkedIn posting was built directly against each platform's API for this project, per the operator's explicit decision during S-08 planning.

#### 2. Roadmap S-08 entry + Parked section

**File**: `context/foundation/roadmap.md`

**Intent**: Same reconciliation as the PRD, plus recording the scope decision as roadmap history (this file's existing convention for every other slice's "Carried forward"/decision notes).

**Contract**: Update the "Rebuilding the social publishing integration" Parked entry and add a decision note under S-08 once shipped, following the exact style of S-07's "Decisions taken at planning" note.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (Prettier formatting on the edited Markdown)

#### Manual Verification:

- `npm run publish -- --digest=<a real approved digest>` against your real Meta and LinkedIn accounts, with real credentials set, produces either a real, visible post on each selected platform or a clearly-attributed real failure per platform — before relying on the unattended Tuesday 17:00 fire
- During that dry run, confirm no platform ever reports an image-fetch/expired-URL error — if one does, `PUBLISH_SIGNED_URL_TTL_SECONDS` needs to be larger than assumed
- PRD and roadmap read correctly to a fresh reader with no memory of this plan

---

## Testing Strategy

### Unit Tests:

- Caption composition and per-platform truncation (Phase 2)
- Each platform publisher against faked HTTP responses: success, a representative API error, and (Instagram/LinkedIn) the multi-image/carousel path (Phase 2)
- `runPublish`'s pending-platform calculation and per-outcome recording, especially the "skip already-succeeded" and "unconfigured" paths (Phase 3)
- Worker target resolution (`--digest` vs newest-eligible vs none) (Phase 4)

### Integration Tests:

- `record_publication` against the real Supabase test project (`SUPABASE_TEST_PROJECT=1`), covering `PB001`/`PB002` and the conditional transition to `published`
- `scheduled-run.ts`'s due-check/claim/release cycle with the new `"publish"` job included

### Manual Testing Steps:

1. With no platform credentials set, run `npm run publish -- --digest=<approved digest>` and confirm it reports `not_configured` per platform and exits cleanly (Phase 4).
2. With real credentials set, run the same command against a real `approved` test digest and confirm real posts appear (or real, clear failures) on each selected platform (Phase 6).
3. From the approve page, manually publish a `skipped` (missed-deadline) digest and confirm the same real-post behavior via the UI path, not just the CLI.
4. Re-run publish (CLI or UI) on a digest where one platform already succeeded and confirm that platform is not re-posted to.

## Performance Considerations

Negligible — a handful of HTTP calls once a week per digest, well within any platform's rate limits at this volume.

## Migration Notes

Additive only: one new table (`publication`), one new RPC, no changes to existing tables or the transition trigger. No backfill needed — publication history starts from the first digest this stage runs against.

## References

- Roadmap entry: `context/foundation/roadmap.md` § S-08
- PRD refs: FR-022, FR-023, US-18, US-19, US-20
- Approval gate precedent (RPC + island + API route shape): `context/archive/2026-09-12-content-approval-gate/`
- Visual assets precedent (signed URLs, per-slide storage): `context/archive/2026-09-08-brand-visual-assets/`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema & publication record

#### Automated

- [x] 1.1 `npm run lint` passes
- [x] 1.2 Migration applies cleanly (`npx supabase db reset` / `db push`) — CLI access to this project returns 403 (same pre-existing gap noted since F-01/S-07), so applied by hand via the SQL Editor and confirmed live: `publication` table reachable via the service-role client, empty, no error
- [x] 1.3 `record_publication` unit test (SQLSTATEs + conditional transition) — `src/lib/publishing/record.test.ts`, 11/11 passing against the real test project (`SUPABASE_TEST_PROJECT=1`)

#### Manual

- [x] 1.4 Inspect applied schema (RLS, grants) in the Supabase dashboard — dashboard UI not available this session; verified by equivalent automated evidence instead: the migration explicitly enables RLS with no policies and grants `execute` on `record_publication` to `service_role` only, and the integration suite's "denies the anon/publishable key" test confirms this live (anon reads return empty/denied)

### Phase 2: Platform publisher clients

#### Automated

- [ ] 2.1 `npm run lint` passes
- [ ] 2.2 `npx vitest run src/lib/publishing/` passes (platform clients against faked HTTP)
- [ ] 2.3 Caption composition/truncation unit tests pass

### Phase 3: Publish orchestration

#### Automated

- [ ] 3.1 `npm run lint` passes
- [ ] 3.2 `npx vitest run src/lib/publishing/run.test.ts` passes
- [ ] 3.3 `record_publication` integration test against the real test project

### Phase 4: Worker entrypoint + scheduler wiring

#### Automated

- [ ] 4.1 `npm run lint` passes
- [ ] 4.2 `npx vitest run src/worker/publish.test.ts` passes
- [ ] 4.3 `npx vitest run src/worker/scheduled-run.test.ts` passes (new "publish" action covered)

#### Manual

- [ ] 4.4 `npm run publish -- --digest=<approved digest>` with no credentials reports `not_configured` per platform and exits cleanly

### Phase 5: Manual publish dashboard action

#### Automated

- [ ] 5.1 `npm run lint` passes
- [ ] 5.2 `npx astro check` passes
- [ ] 5.3 `usePublish` test coverage passes

#### Manual

- [ ] 5.4 "Publish now" on an `approved` test digest with no credentials shows `not_configured` per platform in the UI without a crash
- [ ] 5.5 Approve page shows existing `publication` results on reload without re-triggering
- [ ] 5.6 `/dashboard/<id>` links to the publish action for a `skipped` digest and to results for a `published` digest

### Phase 6: Docs reconciliation + live dry run

#### Automated

- [ ] 6.1 `npm run lint` passes

#### Manual

- [ ] 6.2 Real dry-run publish against real Meta/LinkedIn accounts succeeds (or fails clearly) per platform
- [ ] 6.3 No platform reports an image-fetch/expired-URL error during the dry run
- [ ] 6.4 PRD and roadmap read correctly with no stale "reused from a prior project" claim
