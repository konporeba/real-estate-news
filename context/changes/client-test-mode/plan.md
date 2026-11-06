# Client Test Mode Implementation Plan

## Overview

Make the system safe and complete for a client test on a hosted link: real posting becomes opt-in, the publish step is simulated by default and says so, a test-only button starts a run on demand, and one command runs the background stages on the operator's laptop during a session.

## Current State Analysis

- Both publish paths go through `runPublish` with publishers built from credentials (`src/lib/publishing-admin.ts`, `src/worker/publish.ts`). Credentials present means real posts; credentials absent records `failed: not_configured`, so neither is a usable test.
- The operator's `.env` has the Meta credentials active.
- Runs start only from the Sunday job or `npm run collect`.
- `advance` carries `collecting`/`ranking` weeks touched in the last 6 hours, and `generating`/`rendering` at any age. It never publishes.
- `one_active_digest_per_week` lets a new digest be created for a week whose earlier digest is terminal, so several digests can share a `window_start`; the dashboard's "newest digest" ordering has no tiebreak.
- Collection's lower bound comes from the previous week's digest and articles are unique per digest, so a repeat run in one week gets a full pool.
- `currentWeekWindow` lives in `src/lib/collection/`, which the app may not import.

## Desired End State

- Without `PUBLISHING_ENABLED=true`, no code path can reach a social network: "Publish now" and the worker use test publishers, whatever credentials exist. The result is recorded with a `test-` post id and shown as "Test: nothing was posted".
- Every dashboard page shows a test-mode banner while publishing is off.
- In test mode the dashboard offers "Start a new run"; the worker picks it up and the shortlist email follows.
- `npm run worker:watch` runs only the advance job in a loop, with `.env.client-test` overriding the recipient and dashboard link.

## What We're NOT Doing

- No second Supabase project: the client test shares the one database.
- No multi-recipient email, no written guide, no in-dashboard step hints.
- No Sunday, Monday or Tuesday jobs during sessions: the watcher runs `advance` only.

## Phase 1: Real posting is opt-in

**Files**: `src/lib/publishing/test-publisher.ts` (new), `src/lib/publishing-admin.ts`, `src/worker/publish.ts`, `src/worker/env.ts`, `astro.config.mjs`, `.env.example`, `src/components/AppHeader.astro`, `src/components/PublishPanel.tsx`, `src/components/PublicationResults.astro`, `src/pages/dashboard/[id]/approve.astro`

**Intent**: `publishingEnabled(value)` is true only for the exact string `"true"`. Otherwise both `buildPublishers` return test publishers and never build a real client. The header shows the banner; publish wording and results say nothing was posted.

### Success Criteria:

#### Automated Verification:

- Test publisher, flag and `buildPublishers` tests pass, including real credentials with the flag unset
- Full suite, lint, build pass

## Phase 2: Start a new run

**Files**: `src/lib/digest/start-run.ts` (new), `src/pages/api/digest/start.ts` (new), `src/components/StartRunButton.tsx` (new), `src/pages/dashboard.astro`, `src/lib/digest/week-list.ts`

**Intent**: The endpoint creates a digest for the current Monday–Sunday week, refuses when publishing is enabled, and explains when the week already has an active run. Newest-first lists break ties on `created_at`.

### Success Criteria:

#### Automated Verification:

- Week calculation matches `currentWeekWindow`; start-run integration tests pass
- Full suite, lint, build pass

## Phase 3: Session worker and hosting

**Files**: `src/worker/watch.ts` (new), `package.json`, `.gitignore`, `wrangler.jsonc`, `CLAUDE.md`

**Intent**: `npm run worker:watch` loops `runAdvance` until stopped. The Worker is renamed for a client-facing URL. The operator signs in to Cloudflare; the dashboard is deployed with no social credentials and a client PIN.

### Success Criteria:

#### Automated Verification:

- Watcher tests pass; full suite, lint, build pass

#### Manual Verification:

- Hosted link: sign in, start a run, pick stories, edit, approve, Publish now shows a simulated result, nothing appears on social media

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Real posting is opt-in

#### Automated

- [x] 1.1 Test publisher, flag and buildPublishers tests pass — 6e4c994
- [x] 1.2 Full suite, lint, build pass — 6e4c994

### Phase 2: Start a new run

#### Automated

- [x] 2.1 Week calculation and start-run tests pass
- [x] 2.2 Full suite, lint, build pass

### Phase 3: Session worker and hosting

#### Automated

- [x] 3.1 Watcher tests, full suite, lint, build pass

#### Manual

- [ ] 3.2 Hosted link passes the full walkthrough with nothing posted
