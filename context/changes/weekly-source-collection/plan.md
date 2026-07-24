# Weekly Source Collection Implementation Plan

## Overview

Build the collection stage of the weekly digest pipeline: pull articles published in a week's window from a configured source list, using a per-source tiered method, isolate a blocked source so it cannot fail the run, escalate to fallback sources on a thin week, and record what happened per source. Collection runs as a standalone Node worker — the first piece of the long-lived pipeline process that S-02, S-05 and F-05 will all extend — and is triggerable by hand so a failed Sunday run is recoverable without waiting seven days.

This is roadmap slice S-01, the first consumer of F-01's durable run-state contract, and the prerequisite for S-02 (ranking) and through it the north-star S-03.

## Current State Analysis

F-01 shipped the durable backbone: the `digest`/`article`/`cluster` schema, a Postgres-guarded state machine, and a typed run-state module. Nothing yet writes to it.

- **No collection code exists.** `src/lib/digest/` holds only `run-state.ts` and `state-machine.ts`. There is no worker, no fetching, no source configuration.
- **No execution context for long-running work.** `astro.config.mjs:16` configures `@astrojs/cloudflare` (workerd). `context/foundation/tech-stack.md:30-33` states the pipeline "runs as a separate long-lived Node worker against the same Supabase database" because "the edge runtime is also wrong for long-running work". That worker does not exist; S-01 creates it.
- **F-01's data access is coupled to the Astro runtime.** `src/lib/digest/run-state.ts:15` imports `createServiceClient` from `src/lib/supabase-admin.ts`, which at line 5 does `import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "astro:env/server"` — a Vite virtual module that exists only inside Astro's build. Vitest already needs an alias shim (`vitest.config.ts`, `test/shims/astro-env-server.ts`) to work around it. A plain Node worker importing run-state fails at module resolution.
- **The migration path is broken.** F-01's migration was applied to the cloud project via the SQL Editor, so `supabase_migrations.schema_migrations` has no record of it and the project is not linked (`supabase/.temp` holds only `cli-latest`). The next `supabase db push` replays `20260722173032_digest_core_schema.sql` and aborts on `create type digest_status`. This slice needs a second migration, so the repair can no longer be deferred.
- **No source entity anywhere.** Neither F-01's schema nor the `shape-notes.md` §8 data-model sketch defines a source. FR-002 requires per-source method configuration and US-03 requires recording a failure against a source.
- **No `npm test` in CI for the worker path** — CI runs lint, test and build (`.github/workflows/ci.yml`), and the integration suite self-skips without `SUPABASE_TEST_PROJECT=1`.

### Key Discoveries:

- **The article schema bounds the work.** `article` carries `source_name`, `source_url`, `published_at`, `original_title`, `original_lede` and no body column (`supabase/migrations/20260722173032_digest_core_schema.sql:73-87`). Collection captures title + lede/meta only — exactly the input FR-006 scores on. No article-body fetching is required anywhere in this slice.
- **URL dedupe within a run is already free.** `unique (digest_id, source_url)` (same file, line 86) absorbs the same URL arriving twice, which is what makes the "keep and top up" re-trigger strategy a one-line insert concern rather than a diffing problem. FR-004 explicitly assigns *semantic* dedup to S-02.
- **`collection_completed_at` is the natural window anchor.** F-01 already stores a per-stage checkpoint on `digest` (same file, line 41). The previous digest's value is the lower bound of this digest's collection window, which makes consecutive windows tile without a schema change.
- **`window_start` / `window_end` are `date`, not `timestamptz`** (same file, lines 36-37). Any sub-day boundary cannot be expressed in those columns and must live in the collection filter.
- **Spain and Poland share a timezone.** Both observe CET/CEST (UTC+1/+2) year-round, so `Europe/Madrid` and `Europe/Warsaw` are interchangeable for window arithmetic. The named zone `Europe/Warsaw` is used throughout for consistency with FR-022.
- **The state machine already supports the re-trigger.** `failed → collecting` is a legal transition (`state-machine.ts`), and `transitionDigest` clears `last_error` when leaving `failed`, so FR-018 is a state move that works today.
- **The run-state contract to call**: `createDigest({start, end})` returning `active_digest_exists` on a same-week collision, `getActiveDigestForWeek`, `markStageComplete(id, 'collection')`, `transitionDigest(id, 'ranking' | 'failed', { lastError })`, `resumeDigest(id)`.

## Desired End State

`npm run collect` executes a full collection pass against the configured sources and leaves a digest in `ranking` with its article pool persisted, its `collection_completed_at` checkpoint set, and a `collection_report` recording per-source outcomes. A source that blocks or times out is recorded and skipped; the run still completes. A thin pool triggers the fallback source tier. An empty pool fails the digest with a diagnostic instead of advancing silently. Re-running against a failed digest tops up the pool without discarding what the previous attempt collected.

**Verification:** `npx supabase migration list` shows both migrations applied; `npm test` passes including window-tiling, per-source-isolation, escalation and top-up tests; `npm run collect` against live feeds produces a `ranking` digest whose `collection_report` shows per-source counts; killing the worker mid-run and re-running resumes without data loss.

## What We're NOT Doing

- **Not implementing the news-API or rendered-fetch tiers.** The adapter interface declares all three; only RSS is implemented. The vendor choice for tiers 2-3 stays open until the source list (OQ#1) says which sources actually need them.
- **Not implementing AI web search** (FR-003's last resort). It would be the system's first model spend, and F-03's cost ceiling does not exist yet. The orchestrator leaves an explicit branch and a pointer.
- **Not building the dashboard trigger.** US-02's "trigger from the dashboard" waits for the slices that own the dashboard and the PIN gate (S-03, F-02). This slice ships a CLI.
- **Not building the scheduler.** No cron, no systemd timer, no job queue, no automatic Sunday firing — that is F-05. Collection is invoked by hand.
- **Not clustering, scoring, ranking or translating.** S-02 owns all of it. This slice writes `article` rows and nothing to `cluster`.
- **Not adding a `source` database table.** Source definitions are code-shaped config; only their per-run outcomes are persisted.
- **Not fetching article bodies.** Title, lede/meta description, URL, source name and published date only.

## Implementation Approach

Fix the delivery path first, then remove the runtime coupling, then build collection bottom-up: configuration, then the fetch abstraction with one real adapter, then the orchestrator that composes them, then the entrypoint that runs it.

The controlling design decision is that **collection runs in plain Node**, not in the Astro runtime. That forces F-01's data access to become runtime-agnostic (Phase 2) before any worker code can call it — a small refactor with an outsized payoff, since every later pipeline slice inherits it and the Vitest `astro:env` shim becomes unnecessary for run-state tests.

The second controlling decision is that **partial failure is the expected path, not the exception**. Every source is fetched inside its own error boundary; the orchestrator's job is to compose successes and record failures, never to propagate one source's exception into the run.

## Critical Implementation Details

**Window tiling.** The collection filter's lower bound is the *previous* digest's `collection_completed_at` — the digest with the greatest `window_start` strictly less than this digest's, with a non-null checkpoint — falling back to this digest's `window_start` at 00:00 `Europe/Warsaw` when no such digest exists. The upper bound is the moment the run starts. Critically, this digest's *own* `collection_completed_at` must never be used as the lower bound: on a re-trigger it is already set from the failed attempt, and using it would skip the very window being recovered.

**Ordering around the checkpoint.** `markStageComplete(id, 'collection')` must be called only after articles are persisted and the report is written. It is the anchor the *next* week's window reads, so setting it early on a run that then fails would silently erase a week of coverage.

**Missing publication dates.** RSS items frequently omit or malform their date. Such items are kept (`published_at` null) rather than dropped, because feeds list recent content and silently discarding items loses stories the operator would have wanted. The blast radius is bounded by a per-source item cap rather than by the date filter.

**Fetch politeness.** Sources are fetched with bounded concurrency, a per-source timeout, and a descriptive `User-Agent` identifying the project. FR-002 exists because these sources block automated traffic; hammering them from a home IP is the fastest way to lose the RSS tier too.

## Phase 1: Migration path & schema

### Overview

Repair F-01's unrecorded migration so the CLI is a working delivery path again, then add the second migration this slice needs.

### Changes Required:

#### 1. Migration-history repair

**File**: none (operational)

**Intent**: Make `supabase db push` usable. F-01's schema was applied via the SQL Editor and is absent from the migration history, so a push would replay it and abort.

**Contract**: link the project and mark the existing migration applied — `npx supabase login`, `npx supabase link --project-ref arugswrcmlupwyyumugn`, `npx supabase migration repair --status applied 20260722173032`, then `npx supabase migration list` to confirm local and remote agree. Requires a Supabase login with access to the project; the account currently authenticated in the CLI returns 403 for it.

#### 2. Collection report column + deferred constraint

**File**: `supabase/migrations/<timestamp>_collection_report.sql` (new)

**Intent**: Give the run a durable, queryable record of what each source did, and land the `window_end >= window_start` check deferred from F-01's implementation review (finding F8).

**Contract**: `alter table digest add column collection_report jsonb;` (nullable — a digest has no report until collection runs) and `alter table digest add constraint digest_window_order check (window_end >= window_start);`. No RLS change: `digest` already has RLS enabled with no policies.

#### 3. Regenerated types

**File**: `src/db/database.types.ts` (regenerated)

**Intent**: Keep the `Database` type in step with the schema.

**Contract**: output of `npx supabase gen types typescript --project-id arugswrcmlupwyyumugn > src/db/database.types.ts`; `digest.Row` gains `collection_report: Json | null`.

### Success Criteria:

#### Automated Verification:

- `npx supabase migration list` shows both migrations applied locally and remotely
- `npx supabase db push` reports nothing pending
- Regenerated types include `collection_report`: `npx astro check` passes
- Existing suite still green: `npm test`

#### Manual Verification:

- `collection_report` column and `digest_window_order` constraint visible in Supabase Studio
- Inserting a digest with `window_end` before `window_start` is rejected by the database

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Runtime-agnostic data access

### Overview

Decouple F-01's run-state module from `astro:env/server` so a plain Node process can use it.

### Changes Required:

#### 1. Client injection in run-state

**File**: `src/lib/digest/run-state.ts`

**Intent**: Remove the static import of the Astro-coupled client factory. Each exported function takes the Supabase client it should use, so the module works identically under Astro, Vitest and Node.

**Contract**: every export (`createDigest`, `transitionDigest`, `markStageComplete`, `getActiveDigestForWeek`, `resumeDigest`) takes a typed service client as its first parameter; the `not_configured` result and the `createServiceClient` import are removed, since obtaining a client becomes the caller's responsibility. The `RunStateResult` shape and every remaining failure reason are unchanged.

#### 1a. Failure-reason type

**File**: `src/types.ts`

**Intent**: `not_configured` becomes unreachable once the client is injected, so the union that declares it must lose it too — otherwise the type advertises a result no code can produce.

**Contract**: drop `"not_configured"` from `RunStateErrorReason` (`src/types.ts:32`) and its explanatory line from the doc comment above the union (`src/types.ts:24`). Every other reason is untouched.

#### 2. Runtime-neutral client factory

**File**: `src/lib/supabase-service.ts` (new)

**Intent**: Provide the client constructor both runtimes share, with no environment access of its own.

**Contract**: export `createServiceClient(url: string, serviceRoleKey: string)` returning `SupabaseClient<Database>` configured with `auth: { persistSession: false, autoRefreshToken: false }`, memoized per URL+key pair.

#### 3. Astro-facing wrapper

**File**: `src/lib/supabase-admin.ts`

**Intent**: Keep the existing server-only entry point for Astro code, now delegating rather than constructing.

**Contract**: continues to read `astro:env/server` and return `null` when unconfigured; delegates construction to `supabase-service.ts`. Public signature unchanged.

#### 4. Node-side environment loading

**File**: `src/worker/env.ts` (new)

**Intent**: Give the worker its own typed environment reader, so nothing under `src/worker/` ever touches `astro:env/server`.

**Contract**: zod-validated read of `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `process.env`, throwing a clear startup error naming the missing variable. Values come from `.env` via Node's `--env-file`.

#### 5. Test updates

**Files**: `src/lib/digest/run-state.test.ts`, `vitest.config.ts`

**Intent**: Tests construct a client and inject it, which is what the new API requires and also what makes the `astro:env` alias unnecessary for this suite.

**Contract**: the integration suite builds its client from `process.env` and passes it in; the `not_configured` expectations are dropped. The `astro:env/server` alias stays in `vitest.config.ts` only if another suite still needs it.

### Success Criteria:

#### Automated Verification:

- Existing suite green against the injected API: `npm test`
- A plain Node import of run-state resolves with no Astro build: `node --env-file=.env --experimental-strip-types -e "import('./src/lib/digest/run-state.ts')"` (or the equivalent `tsx` invocation) exits 0
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Production build succeeds: `npm run build`

#### Manual Verification:

- The Astro app still reads a digest server-side through `supabase-admin.ts` (F-01's manual path is unregressed)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Source configuration & tier abstraction

### Overview

Define the source registry and the fetch-adapter interface, and implement the RSS tier.

### Changes Required:

#### 1. Source registry

**File**: `src/lib/collection/sources.ts` (new)

**Intent**: Hold the configured source list as reviewable, typed config — the FR-002 per-source method plus the FR-003 primary/fallback role.

**Contract**: a zod schema and a validated exported array. Each source carries a stable `slug` (the key used in `collection_report`), display `name`, `tier` (`rss` | `api` | `rendered`), `role` (`primary` | `fallback`), the feed/endpoint URL, and an `enabled` flag. Module-level validation throws on a malformed entry. Also exports `MIN_POOL_SIZE` (initial value 20 — the pool must exceed FR-008's top-15 shortlist by enough to cluster meaningfully; revise after observing real weeks) and `MAX_ITEMS_PER_SOURCE` (50).

**Note on the source list**: OQ#1 is unresolved, so the registry is seeded during implementation by verifying candidate Catalan/Spanish outlets — La Vanguardia, El Periódico, Cinco Días, El Economista, Expansión, Europa Press — for a working feed, and recording the verified URL. Only sources whose feed was confirmed to parse are shipped enabled. Idealista is declared with `tier: "rendered"` and `enabled: false`, since FR-002 names it as actively blocking automated fetching. The operator confirms the final list.

#### 2. Fetch-adapter interface

**File**: `src/lib/collection/adapters/types.ts` (new)

**Intent**: One shape for all three tiers so the orchestrator is written once and later tiers slot in without touching it.

**Contract**: an adapter takes a source definition plus the resolved window and returns normalized candidates — `{ sourceUrl, title, lede, publishedAt }` with `publishedAt` nullable. Errors are thrown, not swallowed; isolation is the orchestrator's job.

#### 3. RSS adapter

**File**: `src/lib/collection/adapters/rss.ts` (new)

**Intent**: Implement tier 1, the preferred method for any source that offers a feed.

**Contract**: fetches the feed with a bounded timeout and a descriptive `User-Agent`, parses it with `rss-parser` (covers RSS 2.0 and Atom), and validates each item through zod before normalizing. Lede is taken from the item's description/summary/content-snippet, whichever is present, stripped of markup. Items beyond `MAX_ITEMS_PER_SOURCE` are dropped.

#### 4. Unimplemented tier stubs

**File**: `src/lib/collection/adapters/index.ts` (new)

**Intent**: Make the tier registry total, so an accidentally enabled tier-2/3 source fails loudly rather than being silently skipped.

**Contract**: maps each tier to its adapter; `api` and `rendered` throw a typed `TierNotImplementedError` naming the tier and source slug.

#### 5. Dependency

**File**: `package.json`

**Contract**: add `rss-parser` as a dependency.

### Success Criteria:

#### Automated Verification:

- Source registry validates at import and unit tests cover the role/tier/slug-uniqueness invariants
- RSS adapter unit tests parse recorded RSS 2.0 and Atom fixtures into normalized candidates, including an item with a missing date and one with markup in its description
- Unimplemented tiers throw `TierNotImplementedError`: unit test
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`

#### Manual Verification:

- Each candidate source was checked for a working feed and the outcome recorded in the registry — the enabled list reflects reality, not assumption (partially resolves OQ#1)
- The operator has reviewed and confirmed the shipped source list

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 4: Collection orchestrator

### Overview

Compose the pieces: resolve the window, fetch every source under isolation, escalate on a thin pool, persist articles, write the report, and move the state machine.

### Changes Required:

#### 1. Window resolution

**File**: `src/lib/collection/window.ts` (new)

**Intent**: Implement the tiling cutoff so consecutive digests cover the calendar exactly once.

**Contract**: given a digest and a client, resolve `{ from, to }` — `from` is the previous digest's `collection_completed_at` (greatest `window_start` strictly below this digest's, non-null checkpoint), else this digest's `window_start` at 00:00 `Europe/Warsaw`; `to` is the run's start time. This digest's own checkpoint is never consulted. Also exports the helper that derives the current Monday–Sunday `window_start`/`window_end` date pair for `createDigest`.

#### 2. Collection report schema

**File**: `src/lib/collection/report.ts` (new)

**Intent**: Give the jsonb column a validated TypeScript shape, since the database cannot enforce it.

**Contract**: a zod schema with a `version` discriminator covering the run's cutoff bounds, per-source entries (`slug`, `name`, `role`, `tier`, `status` of `ok`/`failed`/`skipped`, item counts fetched and inserted, error message, duration), the resulting pool size, whether the threshold was met, whether fallbacks ran, and an explicit flag recording that AI web search was skipped pending F-03.

#### 3. Orchestrator

**File**: `src/lib/collection/collect.ts` (new)

**Intent**: The stage entry point S-01 delivers — everything between "a digest exists in `collecting`" and "the digest is in `ranking` or `failed`".

**Contract**: takes a client and a digest, and (a) resolves the window; (b) fetches every enabled `primary` source with bounded concurrency, each inside its own try/catch recording an entry in the report; (c) filters candidates to the window, keeping undated items; (d) inserts articles ignoring conflicts on `unique (digest_id, source_url)` so a re-trigger tops up rather than duplicating; (e) if the pool is below `MIN_POOL_SIZE`, repeats (b)-(d) for `fallback` sources; (f) leaves the documented no-op branch where AI web search belongs, with a pointer to F-03; (g) writes `collection_report`; (h) calls `markStageComplete(client, id, 'collection')`; (i) transitions to `ranking`, or to `failed` with `lastError` when the pool is empty. A thrown adapter error never propagates past step (b).

### Success Criteria:

#### Automated Verification:

> The four database-backed criteria below (isolation, escalation, top-up, state) only execute under `SUPABASE_TEST_PROJECT=1 npm test`. Without the flag they **skip rather than fail**, so a plain `npm test` reporting green does not verify them — run them with the flag before ticking their Progress rows.

- Window-resolution unit tests: previous checkpoint used as lower bound; fallback to `window_start` when no previous digest; own checkpoint ignored on re-trigger; upper bound is run time
- Per-source isolation test: one adapter throws, the remaining sources are still collected and the report records the failure against the failing slug
- Escalation test: fallbacks run when the primary pool is below `MIN_POOL_SIZE` and do not run when it is above
- Top-up test: a second pass over the same digest inserts only URLs not already present
- State test: a non-empty pool transitions to `ranking`; an empty pool transitions to `failed` with `last_error` set
- Report validates against its zod schema in every test path
- Type checking, linting and the full suite pass: `npx astro check`, `npm run lint`, `npm test`

#### Manual Verification:

- A `collection_report` from a test run is readable in Supabase Studio and answers "why was the digest thin?" without consulting logs

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 5: Worker entrypoint & CLI

### Overview

Make it runnable: a Node entrypoint that creates or resumes the week's digest and invokes the orchestrator.

### Changes Required:

#### 1. Collection entrypoint

**File**: `src/worker/collect.ts` (new)

**Intent**: The FR-018 manual trigger and the process F-05 will later schedule.

**Contract**: loads env via `src/worker/env.ts`, builds the service client, then resolves the target digest in this order: (a) the week named by an explicit `--week=YYYY-MM-DD` flag, if given; (b) otherwise the newest *recoverable* digest — the greatest `window_start` whose status is non-terminal or `failed`; (c) otherwise a new digest for the current Monday–Sunday. The resolved week is always printed before work starts. Having resolved it, the digest's status decides what happens next: absent → create it; `failed` → transition back to `collecting` per FR-018; already `collecting` → proceed straight to the orchestrator with no transition (this is the state a worker killed mid-run leaves behind, and the orchestrator's top-up insert is exactly the right recovery — a self-transition would be rejected by `canTransition` anyway); past `ranking` → refuse with a clear message. Invokes the orchestrator, prints a per-source summary, and exits non-zero when the run ends in `failed`.

Resolution order (b) before (c) is what makes FR-018 work by default: the operator notices a failed Sunday run on Monday or later, by which time "the current week" is the *wrong* week — defaulting to the calendar would create a fresh, near-empty digest and leave the failed one stranded.

#### 1a. Recoverable-digest lookup

**File**: `src/lib/digest/run-state.ts`

**Intent**: Support resolution step (b) — the entrypoint needs to find the newest digest still worth working on, which `getActiveDigestForWeek` (keyed on a specific week) cannot express.

**Contract**: export `getLatestRecoverableDigest(client)` returning `RunStateResult<DigestRun | null>` — the row with the greatest `window_start` whose status is not in `('published', 'skipped')`, i.e. non-terminal digests plus `failed` ones, which FR-018 makes re-triggerable.

#### 2. Scripts and runner

**File**: `package.json`

**Contract**: add `tsx` as a dev dependency and a `"collect": "tsx --env-file=.env src/worker/collect.ts"` script.

#### 3. Live smoke test

**File**: `src/lib/collection/adapters/rss.live.test.ts` (new)

**Intent**: Catch a source silently changing its feed format — the failure fixtures cannot see.

**Contract**: env-gated on an explicit opt-in flag (mirroring `SUPABASE_TEST_PROJECT`), fetches each enabled RSS source and asserts at least one item parses into a valid candidate. Skips by default so CI stays hermetic.

#### 4. Runtime-boundary enforcement

**File**: `eslint.config.js`

**Intent**: Make the two-runtime split structural rather than remembered. The app builds for workerd while collection code is Node-oriented (`rss-parser`), so an import crossing the boundary in either direction breaks a build — and would do so in whichever slice happens to add the import, far from this plan.

**Contract**: `no-restricted-imports` (or `no-restricted-paths`) rules expressing both directions — `src/pages/**` and `src/components/**` may not import `src/lib/collection/**` or `src/worker/**`; `src/worker/**` and `src/lib/collection/**` may not import `astro:env/server` or `src/lib/supabase-admin`. Each rule carries a message naming the runtime that would break.

#### 5. Documentation

**File**: `CLAUDE.md`

**Contract**: document `npm run collect` and the worker/Astro runtime split in both directions — anything under `src/worker/` or `src/lib/collection/` runs in plain Node, must not import `astro:env/server`, and must not be imported from a page or island, because the app bundle targets workerd. Point at the ESLint rules as the enforcement.

### Success Criteria:

#### Automated Verification:

- `npm run collect` completes end-to-end and exits 0 against the configured sources
- Week-resolution tests: an explicit `--week` wins; with a `failed` digest from an earlier week present, the default targets that digest rather than the current week; with no recoverable digest, the current Monday–Sunday is created
- The live smoke test passes when its opt-in flag is set, and skips without it
- The runtime-boundary lint rules fire: a deliberate import of `src/lib/collection/` from a page, and of `astro:env/server` from `src/worker/`, are each rejected by `npm run lint` (revert both after verifying)
- Full suite, type check, lint and build pass: `npm test`, `npx astro check`, `npm run lint`, `npm run build`

#### Manual Verification:

- A real run against live feeds leaves a digest in `ranking` with a plausible article pool, and spot-checked articles have sensible titles, ledes and dates
- `collection_report` shows per-source counts, and a deliberately broken source URL is recorded as failed without failing the run
- Re-running `npm run collect` for the same week tops up rather than duplicating, and a digest already past `ranking` is refused
- Killing the worker mid-run and re-running recovers the week with no lost articles

**Implementation Note**: After completing this phase and all automated verification passes, pause for final manual confirmation.

---

## Testing Strategy

### Unit Tests:

- Source registry invariants: unique slugs, valid tier/role, zod rejection of malformed entries
- RSS parsing from recorded fixtures: RSS 2.0, Atom, missing date, markup in description, item cap
- Window resolution: all four tiling cases including the re-trigger trap
- Report schema validation
- Unimplemented tier stubs throw

### Integration Tests (against the configured Supabase project, opt-in):

- Per-source isolation: one failing adapter does not stop the run
- Thin-week escalation fires below the threshold and not above
- Re-trigger tops up without duplicating (exercises `unique (digest_id, source_url)`)
- Empty pool → `failed` with `last_error`; non-empty → `ranking`
- Checkpoint written only after articles are persisted

### Live Smoke (opt-in, excluded from CI):

- Every enabled RSS source still returns a parseable feed

### Manual Testing Steps:

1. Run `npm run collect` for the current week; confirm the digest lands in `ranking` and inspect the pool in Studio.
2. Point one source at a dead URL, re-run for a fresh week, and confirm the run completes with that source recorded as failed.
3. Force a failure (disable every source), confirm the digest goes to `failed`, then restore and re-trigger to confirm FR-018 recovery.
4. Re-run collection for a week that already collected; confirm article count grows only by genuinely new URLs.
5. Confirm the next week's run picks up items published after the previous run's checkpoint (window tiling).

## Performance Considerations

Not a hotspot: a handful of sources, once a week, on a Raspberry Pi that is waiting on the network. Bounded concurrency and per-source timeouts exist to be polite to sources and to stop one hanging feed from stalling the run — not for throughput. The per-source item cap bounds memory and the insert size.

## Migration Notes

This slice adds the project's second migration and repairs the first one's missing history entry (Phase 1). After Phase 1, `supabase db push` is the delivery path and the SQL Editor should not be used again. Type regeneration after a migration remains a manual step, noted in the run-state module header.

Phase 2 changes an exported API that F-01 shipped: run-state functions gain a client parameter. The only current callers are the F-01 tests, so the blast radius is contained — but any code written against the old signature between now and implementation will need updating.

## References

- Roadmap item: `context/foundation/roadmap.md` → S-01
- Requirements: `context/foundation/prd.md` → FR-001, FR-002, FR-003, FR-018; US-01→04
- Collection design rationale: `context/foundation/shape-notes.md` §5 (Collection), §4 (weekly rhythm), §12 (cost tiering)
- Run-state contract: `src/lib/digest/run-state.ts`
- Schema this builds on: `supabase/migrations/20260722173032_digest_core_schema.sql`
- Prior slice + its review findings (F1 repair, F8 constraint): `context/archive/2026-07-22-durable-digest-run-state/`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Migration path & schema

#### Automated

- [ ] 1.1 `npx supabase migration list` shows both migrations applied locally and remotely
- [ ] 1.2 `npx supabase db push` reports nothing pending
- [ ] 1.3 Regenerated types include `collection_report`; `npx astro check` passes
- [ ] 1.4 Existing suite still green: `npm test`

#### Manual

- [ ] 1.5 `collection_report` column and `digest_window_order` constraint visible in Studio
- [ ] 1.6 Digest with `window_end` before `window_start` is rejected by the database

### Phase 2: Runtime-agnostic data access

#### Automated

- [x] 2.1 Existing suite green against the injected API: `npm test` — add8960
- [x] 2.2 Plain Node import of run-state resolves with no Astro build — add8960
- [x] 2.3 Type checking passes: `npx astro check` — add8960
- [x] 2.4 Linting passes: `npm run lint` — add8960
- [x] 2.5 Production build succeeds: `npm run build` — add8960

#### Manual

- [x] 2.6 Astro app still reads a digest server-side through `supabase-admin.ts` — add8960

### Phase 3: Source configuration & tier abstraction

#### Automated

- [x] 3.1 Source registry validates at import; unit tests cover role/tier/slug-uniqueness invariants — 877cf43
- [x] 3.2 RSS adapter unit tests parse RSS 2.0 and Atom fixtures, including missing date and markup cases — 877cf43
- [x] 3.3 Unimplemented tiers throw `TierNotImplementedError` — 877cf43
- [x] 3.4 Type checking passes: `npx astro check` — 877cf43
- [x] 3.5 Linting passes: `npm run lint` — 877cf43

#### Manual

- [x] 3.6 Each candidate source checked for a working feed; enabled list reflects verified reality (OQ#1) — 877cf43
- [x] 3.7 Operator has reviewed and confirmed the shipped source list — 877cf43 (confirmed 2026-07-24; also enabled the two Catalan sources, widening FR-013 to {es,ca}→pl)

### Phase 4: Collection orchestrator

#### Automated

- [x] 4.1 Window-resolution unit tests pass (previous checkpoint, fallback, own-checkpoint ignored, upper bound) — 8187e6d
- [ ] 4.2 Per-source isolation test: a throwing adapter does not stop the run and is recorded (needs `SUPABASE_TEST_PROJECT=1`)
- [ ] 4.3 Escalation test: fallbacks run below `MIN_POOL_SIZE`, not above (needs `SUPABASE_TEST_PROJECT=1`)
- [ ] 4.4 Top-up test: a second pass inserts only new URLs (needs `SUPABASE_TEST_PROJECT=1`)
- [ ] 4.5 State test: non-empty pool → `ranking`; empty pool → `failed` with `last_error` (needs `SUPABASE_TEST_PROJECT=1`)
- [ ] 4.6 Report validates against its zod schema in every test path
- [ ] 4.7 Type checking, linting and full suite pass

#### Manual

- [ ] 4.8 A `collection_report` is readable in Studio and explains a thin digest without logs

### Phase 5: Worker entrypoint & CLI

#### Automated

- [ ] 5.1 `npm run collect` completes end-to-end and exits 0
- [ ] 5.2 Week-resolution tests pass (`--week` wins; failed digest beats current week; else create current)
- [ ] 5.3 Live smoke test passes with its opt-in flag and skips without it
- [ ] 5.4 Runtime-boundary lint rules reject a deliberate cross-runtime import in both directions
- [ ] 5.5 Full suite, type check, lint and build pass

#### Manual

- [ ] 5.6 Real run leaves a digest in `ranking` with a plausible, spot-checked article pool
- [ ] 5.7 A deliberately broken source is recorded as failed without failing the run
- [ ] 5.8 Re-running tops up without duplicating; a digest past `ranking` is refused
- [ ] 5.9 Worker killed mid-run recovers the week on re-run with no lost articles
