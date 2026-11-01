# Week Management Implementation Plan

## Overview

Let the operator manage weeks from the dashboard: delete an outdated week for good, close one so
nothing publishes and it stops asking for attention, retry a failed week from the stage that
failed, and edit a story's Polish text before approving. The "Previous weeks" filters switch
without reloading the page. Underneath, the Pi worker starts running the writing and slide stages
on its own, which both retry and editing depend on — and which production never had.

## Current State Analysis

- `src/pages/dashboard.astro` renders "Previous weeks" as plain links; each filter (`All`,
  `Needs me`, `Published`) is an `<a href="/dashboard?view=…">`, so every click is a full page load.
  Rows are one big link each — there is nowhere to put an action.
- No route deletes or edits a digest. Every child table (`cluster`, `article`, `selection`,
  `generated_copy`, `generated_asset`, `approval`, `publication`) is `on delete cascade` from
  `digest`, but slide PNGs in the private `digest-assets` bucket are not — deleting the row alone
  would orphan them.
- `scheduled-run` (`src/worker/scheduled-run.ts`) runs three weekly jobs: `collection`
  (collect + rank), `approval-reminder`, `publish`. **Nothing runs `generate` or `visuals`**: after
  `confirm_selection` moves a week to `generating`, it sits there until `npm run generate` and
  `npm run visuals` are run by hand.
- State machine (`src/lib/digest/state-machine.ts`, mirrored by the `enforce_digest_transition`
  trigger, latest in `20260912093000_approval_gate.sql`): `failed → collecting | generating |
  rendering` and `rejected → generating` already exist (retry paths). There is no way to end a week
  without publishing: `skipped` stays publishable and the Tuesday job publishes `approved` *and*
  `skipped` weeks (`src/worker/publish.ts:55`). There is no `ready_for_approval → rendering`.
- Checkpoints on `digest`: `collection_completed_at`, `ranking_completed_at`,
  `generation_completed_at`, `rendering_completed_at` — enough to tell which stage a failed week
  stopped at.
- Live data (2026-11-01): 26 Oct `ready_for_approval` (current); 14 Sep `failed` (ranking
  truncated); 7 Sep `failed` (generation); **31 Aug `approved`** (would be posted by the Pi's
  Tuesday job); 27 Jul `ready_for_selection` (stale); 20 Jul `ranking` (stuck since July).
- Migrations are applied by hand in the Supabase SQL Editor (no linked CLI). There is one Supabase
  project: the integration tests and production share it.
- `src/lib/visuals/fit.ts` (pure, no imports but a type) decides whether a story's text fits its
  slide; the app can't import `@/lib/visuals/*`, so today only the worker can check fit.
- Ranking's few-shot examples come from past `selection_item` rows (`src/lib/ranking/few-shot.ts`):
  deleting a week removes its picks from that pool.

## Desired End State

- Each week (list row and week page) has a menu offering only the actions valid for it:
  **Retry** (failed, or sent back), **Close** (anything not finished and not running right now),
  **Delete** (anything not running right now). Each goes through a confirmation dialog saying what
  happens. A week in a working state whose `updated_at` is over 3 hours old counts as stuck, not
  running, so the July weeks can be closed or deleted.
- Delete erases the week, everything under it, and its slide images. Published posts stay on
  social media (the dialog says so).
- Close moves the week to a new terminal status `closed` ("Closed" chip): never published, not in
  "Needs me", not in the reminder, frees its week for a re-collect, and can only be deleted after.
- Retry moves a failed week back to the stage it stopped at (`collecting`, `generating` or
  `rendering`), and a sent-back week to `generating`; the Pi picks it up within minutes.
- On the approval page, **Edit text** lets the operator change each story's title, caption and body
  copy; saving checks the text still fits the slide, stores it, and sends the week back to
  `rendering`; the Pi re-renders and the approval email arrives again.
- The filters swap the list in place (no reload), keep the URL in sync, and still work as plain
  links without JavaScript.
- The Pi's `scheduled-run` advances any week in `generating`/`rendering`, and any week in
  `collecting`/`ranking` touched in the last 6 hours, by running the same `main()`s the commands use.

### Key Discoveries:

- Every worker `main(argv)` accepts `--digest=<uuid>` (`collect.ts` takes `--week=`) and returns an
  exit code without exiting, so the advance job composes them in-process exactly like
  `runCollectionJob` does.
- `ConfirmDialog.tsx` already implements the native-`<dialog>` confirmation every irreversible
  action uses.
- Adding an enum value must be its own migration file (`20260912090000_rejected_status_enum.sql`
  explains why); the trigger and index change go in a second file.

## What We're NOT Doing

- No reopening of story selection (not requested).
- No editing of key statistics, the source, the picks, or a week that is already approved.
- No numeric-integrity gate on the operator's own edits — the operator is the authority on their
  text; only fit is enforced.
- No undo for delete; no "archived" view.
- No change to the publish, reminder or collection schedules themselves.
- No rework of the single-post deck (deferred by the operator).

## Implementation Approach

Pure, unit-tested decisions in shared `src/lib/digest/` modules (which actions a week allows, which
stage a retry goes to, whether text fits), thin authenticated API routes that apply them through
the service client, and two React islands (the week list, the story editor). The worker gains one
always-due job. The migration lands before any route that writes `closed` or the new edge.

## Phase 1: The Pi runs the writing and slide stages on its own

### Changes Required:

#### 1. Advance job

**Files**: `src/lib/scheduler/registry.ts`, `src/lib/scheduler/schedule.ts`, `src/worker/scheduled-run.ts`

**Intent**: Add an `advance` job that is due on every invocation (a schedule kind alongside
`WeeklySchedule`, claimed like any job so two invocations never overlap). Its action reads digests
in `generating`/`rendering` (any age) and `collecting`/`ranking` (`updated_at` within 6 hours —
older ones are crashed runs the operator closes or deletes), oldest first, and runs
`generate` → `visuals`, `visuals`, or `collect` → `rank` for each via their `main()`. One failing
week does not stop the others; the job's `last_error` names them.

**Contract**: `JOB_ACTIONS.advance`; registry entry `{ name: "advance", schedule: { every: "run" } }`.

#### 2. Timer cadence

**File**: `deploy/systemd/real-estate-news-scheduled-run.timer`, `deploy/systemd/README.md`

**Intent**: `OnCalendar=*:0/5` so a confirmed pick, retry or edit starts within 5 minutes.

### Success Criteria:

#### Automated Verification:

- Scheduler/advance tests (always due, picks the right digests, skips stale `ranking`, one failure doesn't stop the rest, overlapping claim skips) pass
- Full suite, lint, build pass

---

## Phase 2: `closed` status and the edit edge

### Changes Required:

#### 1. Migrations

**Files**: `supabase/migrations/20261101120000_closed_status_enum.sql` (enum value only),
`supabase/migrations/20261101120100_week_management.sql`

**Intent**: Add `closed` (after `skipped`). Trigger allows `→ closed` from every status except
`published` and `closed`, and `ready_for_approval → rendering`; `closed` has no way out.
`one_active_digest_per_week` excludes `closed`.

#### 2. App mirror

**Files**: `src/lib/digest/state-machine.ts` (+ drift test), `src/types.ts`,
`src/db/database.types.ts`, `src/lib/digest/presentation.ts`, `src/components/StatusChip.astro`

**Intent**: Same map in TS; `closed` is terminal; label "Closed", quiet tone; not in
`NEEDS_OPERATOR_STATUSES`; timeline not drawn.

### Success Criteria:

#### Automated Verification:

- State-machine drift test passes against the new migration
- Presentation tests pass; full suite, lint, build pass

#### Manual Verification:

- Operator gives the go; both migration files applied in the Supabase SQL Editor; integration suite green against the migrated database

---

## Phase 3: Instant filters

### Changes Required:

**Files**: `src/pages/api/digests.ts` (new), `src/components/WeekList.tsx` (new),
`src/pages/dashboard.astro`

**Intent**: `GET /api/digests?view=&before=` returns the page of weeks as JSON (same query, same
keyset pagination as today, auth required). The list and filters become a `WeekList` island seeded
with the server-rendered first page; a filter click fetches, swaps the rows, and `pushState`s the
URL; back/forward restore the view; "Show older weeks" appends. Links keep their `href` so the page
works without JavaScript.

### Success Criteria:

#### Automated Verification:

- API route tests (auth, view filter, cursor) pass; lint, build pass

#### Manual Verification:

- Switching filters doesn't reload the page; back button returns to the previous filter

---

## Phase 4: Delete, close, retry

### Changes Required:

#### 1. Decisions

**File**: `src/lib/digest/week-actions.ts` (new, pure)

**Contract**: `availableActions(digest, now): ("retry" | "close" | "delete")[]`;
`retryTarget(digest): DigestStatus | null` — `rejected` → `generating`; `failed` →
`rendering` if `generation_completed_at`, `generating` if a selection exists, else `collecting`.
Working state + `updated_at` < 3 h ago ⇒ no actions ("running now").

#### 2. API

**File**: `src/pages/api/digest/action.ts` (new)

**Intent**: `POST { digestId, action }`, zod-validated, operator session required. Re-reads the
digest and re-checks `availableActions` server-side. Delete: read its `generated_asset.storage_path`s,
delete the row (cascade), then remove the files — a storage failure is logged and reported as a
warning, not a failure. Close / retry: `transitionDigest` (the trigger is the final guard; retry
also clears `last_error`).

**Contract**: `{ ok: true, digest? } | { ok: false, reason: "unauthorized" | "invalid_request" | "not_found" | "not_allowed" | "database_error", message }`.

#### 3. UI

**Files**: `src/components/WeekActions.tsx` (new), `WeekList.tsx`, `src/pages/dashboard/[id].astro`

**Intent**: A "⋯" menu per row and on the week page header; each action opens `ConfirmDialog`
with plain consequences (delete: "can't be undone; posts already on Facebook/Instagram stay
there"; close: "won't be published and stops asking for your attention"; retry: "the Pi picks it
up within 5 minutes"). The list updates in place; the week page reloads to its new state, or
returns to the dashboard after delete.

### Success Criteria:

#### Automated Verification:

- `week-actions` unit tests (every status × running/stuck; retry targets) pass
- API integration tests (delete removes rows and files; close; retry; refusal of a running week; auth) pass
- Full suite, lint, build pass

#### Manual Verification:

- Operator closes the 31 Aug week and deletes/closes the other outdated weeks from the dashboard

---

## Phase 5: Edit the post text

### Changes Required:

#### 1. Shared fit check

**Files**: move `src/lib/visuals/fit.ts` → `src/lib/digest/fit.ts` (and its test); update imports

**Intent**: The app's save route and the worker's renderer use the same fit rules.

#### 2. API

**File**: `src/pages/api/digest/copy.ts` (new)

**Intent**: `POST { digestId, stories: [{ clusterId, polishTitle, captionSummary, bodyCopy }] }`;
only while `ready_for_approval`; every field non-empty after trimming; carousel text must pass
`fitCarouselText`, single-post titles `fitTitle`. Updates the `generated_copy` rows, then
`ready_for_approval → rendering`.

#### 3. UI

**Files**: `src/components/StoryEditor.tsx` (new), `src/pages/dashboard/[id]/approve.astro`

**Intent**: "Edit text" on the approval page opens the editor for all stories with a live "fits /
too long" hint; save confirms ("the slides are redrawn; you'll get the approval email again"). The
page shows a "Updating the slides" notice while the week is in `rendering`.

### Success Criteria:

#### Automated Verification:

- Fit tests pass from the new location; copy API tests (wrong status, too long, empty, unknown story, success → `rendering`) pass
- Full suite, lint, build pass

#### Manual Verification:

- Operator edits a story on the current week's approval page; after the re-render the slide shows the new text

---

## Phase 6: Docs, deploy

### Changes Required:

**Files**: `CLAUDE.md` (scheduled-run jobs, new routes), `context/foundation/prd.md` (closed status, edit before approval)

**Intent**: Then, each on the operator's go: push + PR (CI), `wrangler deploy`, Pi update
(`git pull`, `npm ci`, reinstall the timer) — after the 31 Aug week is closed, and with the
`META_*` credentials restored in the Pi's own `.env` only when the operator decides.

### Success Criteria:

#### Automated Verification:

- CI green on the PR

#### Manual Verification:

- Production dashboard: filters, actions and editing work
- Pi: a confirmed pick reaches "ready for approval" without any manual command

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: The Pi runs the writing and slide stages on its own

#### Automated

- [x] 1.1 Scheduler/advance tests pass — 6bcb5c3
- [x] 1.2 Full suite, lint, build pass — 6bcb5c3

### Phase 2: `closed` status and the edit edge

#### Automated

- [x] 2.1 State-machine drift test passes against the new migration
- [x] 2.2 Presentation tests, full suite, lint, build pass

#### Manual

- [x] 2.3 Migrations applied in the Supabase SQL Editor; integration suite green

### Phase 3: Instant filters

#### Automated

- [ ] 3.1 API route tests, lint, build pass

#### Manual

- [ ] 3.2 Filters switch without a reload; back button works

### Phase 4: Delete, close, retry

#### Automated

- [ ] 4.1 week-actions unit tests pass
- [ ] 4.2 Action API integration tests pass
- [ ] 4.3 Full suite, lint, build pass

#### Manual

- [ ] 4.4 Operator closes the 31 Aug week and clears the other outdated weeks

### Phase 5: Edit the post text

#### Automated

- [ ] 5.1 Fit and copy API tests pass
- [ ] 5.2 Full suite, lint, build pass

#### Manual

- [ ] 5.3 An edited story shows the new text after the re-render

### Phase 6: Docs, deploy

#### Automated

- [ ] 6.1 CI green on the PR

#### Manual

- [ ] 6.2 Production dashboard: filters, actions and editing work
- [ ] 6.3 Pi: a confirmed pick reaches "ready for approval" with no manual command
