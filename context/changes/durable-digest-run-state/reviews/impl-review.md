<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Durable Digest Run-State & Core Schema

- **Plan**: context/changes/durable-digest-run-state/plan.md
- **Scope**: Phases 1-3 of 3 (full plan)
- **Date**: 2026-07-24
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 5 warnings, 4 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | WARNING |
| Scope Discipline    | WARNING |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | WARNING |

## Automated verification (re-run at review time)

| Command          | Result                                                |
| ---------------- | ----------------------------------------------------- |
| `npx vitest run` | PASS — 2 files, 29 tests                              |
| `npx astro check`| PASS — 0 errors, 0 warnings (4 pre-existing hints)     |
| `npm run lint`   | PASS — clean                                          |
| `npm run build`  | PASS — server built in 26.6s                          |
| `npx supabase db reset` (Phase 1 criterion) | NOT RUN — no local stack; see F2 |

## Findings

### F1 — Cloud schema was applied outside the migration history

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260722173032_digest_core_schema.sql
- **Detail**: Phase 1's commit message states the migration was applied to the cloud project via the SQL Editor. `supabase/.temp` contains only `cli-latest` (no `project-ref`), so the project has never been linked and `supabase db push` has never run. The cloud database therefore has the schema but no corresponding row in `supabase_migrations.schema_migrations`. The plan's own Migration Notes assume `db push` is the delivery path. The next `db push` will replay this migration from scratch and abort on `create type digest_status` (already exists), blocking that and every subsequent migration until the history is repaired by hand.
- **Fix A ⭐ Recommended**: Link the project and backfill the history — `npx supabase link --project-ref arugswrcmlupwyyumugn`, then `npx supabase migration repair --status applied 20260722173032`, then confirm with `npx supabase migration list`.
  - Strength: Restores the CLI as the single delivery path before a second migration exists, which is the cheapest possible moment to fix it.
  - Tradeoff: Requires the database password for the link step.
  - Confidence: HIGH — `migration repair` exists precisely for schema applied out-of-band.
  - Blind spot: Have not queried `schema_migrations` directly (PostgREST does not expose that schema, and the MCP server denied the query), so the empty-history conclusion is inferred from the unlinked CLI state and the commit message rather than observed.
- **Fix B**: Make the migration replay-safe (`create table if not exists`, enum creation wrapped in a `do $$ ... exception when duplicate_object $$` block).
  - Strength: No credentials needed; survives any future replay.
  - Tradeoff: Weakens the migration's guarantee that a fresh database matches this file exactly, and the drift is invisible.
  - Confidence: MEDIUM — works, but trades a one-time fix for permanent ambiguity.
  - Blind spot: Does not fix the missing history row; `db push` would still consider the migration unapplied.
- **Decision**: SKIPPED — Fix A was chosen, then blocked: the logged-in Supabase CLI account cannot
  reach `arugswrcmlupwyyumugn` (`branches list` → 403; `projects list` shows only MindTutor and
  personal-nutrition-tracker), so `link` fails before the DB-password step. Repair requires
  `npx supabase login` with the owning account first. Deferred by decision — revisit before the
  next `supabase db push`, which will otherwise abort on `create type digest_status`.

### F2 — Progress rows 1.1-1.3 assert a command that was never run

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/durable-digest-run-state/plan.md (Progress § Phase 1)
- **Detail**: Rows 1.1-1.3 are checked and SHA-stamped (00280d7) with text reading "Migration applies cleanly to a fresh local DB: `npx supabase db reset`" and "No SQL lint/parse errors during apply". `npx supabase status` reports no container, so no local stack has ever existed on this machine. The schema was instead applied to the cloud project via the SQL Editor and verified there. The underlying property (the migration applies cleanly) does have evidence; the recorded claim just names a verification route that was not taken.
- **Fix**: Reword rows 1.1-1.3 to describe what was actually verified ("Migration applied cleanly to the cloud project via SQL Editor"), or run `npx supabase start && npx supabase db reset` once to make the original claim true — the latter also proves the file reproduces a fresh database, which nothing currently proves.
- **Decision**: FIXED — Progress row 1.1 reworded to "Migration applied cleanly to the cloud project
  via SQL Editor (no local stack; `npx supabase db reset` not run)". Rows 1.2 and 1.3 left as-is:
  both are true of the cloud apply and name no unrun command.

### F3 — `.env.example` and CLAUDE.md never learned about the service-role key

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: .env.example:1-2; CLAUDE.md § Environment
- **Detail**: Phase 2 added `SUPABASE_SERVICE_ROLE_KEY` to `.env` and `.dev.vars` exactly as the plan specified — but both are gitignored. The tracked template `.env.example` still lists only `SUPABASE_URL` and `SUPABASE_KEY`, and CLAUDE.md still reads "Env vars: `SUPABASE_URL`, `SUPABASE_KEY` (copy `.env.example` to `.env` ...)". A fresh clone that follows the documented setup gets a `createServiceClient()` that silently returns `null`, so every run-state call fails with `not_configured` and the integration suite silently skips. The omission originates in the plan (Phase 2 § 3 names only the two gitignored files), so this is a plan gap as much as an implementation one.
- **Fix**: Add `SUPABASE_SERVICE_ROLE_KEY=###` to `.env.example` and extend CLAUDE.md's Environment bullet to name the third variable and where to get it (Supabase dashboard → Settings → API → `service_role`).
- **Decision**: FIXED — `.env.example` now lists `SUPABASE_SERVICE_ROLE_KEY=###` with a comment
  pointing at Settings → API; CLAUDE.md's Environment section names the third variable and spells
  out the `null` / `not_configured` failure mode when it is missing.

### F4 — The new test suite is not wired into CI, and CI is dead on this branch

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: .github/workflows/ci.yml:4-6, 20
- **Detail**: Phase 3 introduced the migration-drift guard — the test that fails when the TypeScript `TRANSITIONS` map and the SQL trigger diverge — but `ci.yml` runs only `npm run lint` and `npm run build`. A guard that only runs when someone remembers to run it locally does not protect the invariant it was written for. Compounding this, the workflow triggers on `push`/`pull_request` to `master` while the repository's branch is `main`, so CI does not currently execute at all.
- **Fix**: Add `- run: npm test` after the lint step and change both trigger branches to `main`. No new secret is needed: the integration suite self-skips without `SUPABASE_SERVICE_ROLE_KEY`, so the unit tests and the drift guard still run and stay green in CI.
- **Decision**: FIXED — `npm test` added between lint and build (with a comment explaining the
  self-skip), and both trigger branches changed `master` → `main`. The no-secret assumption was
  verified rather than assumed: `loadEnv('test', <dir without .env>, 'SUPABASE_')` returns `{}`, so
  on CI `configured` is false and only the unit tests plus drift guard execute.

### F5 — Integration tests bind to whatever `.env` points at — currently the live project

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/digest/run-state.test.ts:22, 71
- **Detail**: The suite activates whenever `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, and writes with the RLS-bypassing service-role key. Today that is the real cloud project. Blast radius is deliberately small — synthetic 1970 week windows, `beforeAll`/`afterAll` purge scoped to `1970-01-01..1970-12-31`, and a post-run check confirmed zero rows left behind — but that safety lives in a convention inside the test file, not in a boundary. Once the project holds real digests, or once a later slice attaches triggers/webhooks/cost accounting to `digest` inserts, a routine `npm test` writes to production. This was an explicit, user-approved deviation from the plan's "local Supabase" specification; the finding is about hardening it, not reversing it.
- **Fix A ⭐ Recommended**: Require an explicit opt-in in addition to the key — e.g. gate on `SUPABASE_TEST_PROJECT=1`, or read a dedicated `SUPABASE_TEST_URL` — so aiming the suite at production becomes a deliberate act rather than the default.
  - Strength: One-line change to the `configured` predicate; keeps the current workflow for whoever sets the flag, and makes the risk impossible to hit by accident.
  - Tradeoff: One more variable to set on a new machine; forgetting it silently skips the integration tests (same failure mode as today's missing-key case).
  - Confidence: HIGH — the skip mechanism already exists and is proven by the current green run.
  - Blind spot: Does not prevent someone from setting the flag while `.env` still points at production.
- **Fix B**: Stand up the local stack (`npx supabase start`, `db reset`) and point the tests at 127.0.0.1, reserving the cloud project for deploys.
  - Strength: True isolation; also makes Phase 1's `db reset` criterion (F2) genuinely verifiable and proves the migration reproduces a fresh database.
  - Tradeoff: Multi-GB Docker pull, a second database to keep in sync, and the local stack must be running for the suite to mean anything.
  - Confidence: MEDIUM — standard Supabase workflow, but it is the path the operator has already declined once.
  - Blind spot: Have not verified the local stack starts cleanly on this machine.
- **Decision**: FIXED via Fix A — the suite now requires `SUPABASE_TEST_PROJECT=1` in addition to
  the URL and service-role key. Documented in `.env.example` (with the reason) and in CLAUDE.md;
  the flag was added to the local `.env` so the existing workflow keeps working. Verified both
  directions: with the opt-in, 29 tests pass; with `SUPABASE_TEST_PROJECT=0`, 17 pass and the 12
  integration tests skip — the drift guard still runs, which is the CI shape.

### F6 — `transitionDigest` clears `last_error` on every transition

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/digest/run-state.ts:98
- **Detail**: The update patch is `{ status: to, last_error: options.lastError ?? null }`, so any caller that transitions into `failed` without passing `lastError` overwrites whatever diagnostic was there. Clearing on `failed → collecting` is intended and correct; clearing on an unannotated `→ failed` makes the column quietly lossy exactly when it matters. The integration test covers the happy path (set, then cleared on re-trigger), so the gap is invisible to the suite.
- **Fix**: Omit `last_error` from the patch when `options.lastError` is `undefined` and the target is not `collecting`, so an explicit clear stays explicit.
- **Decision**: FIXED — the patch is now built conditionally: `last_error` is written only when the
  caller supplies it (passing `null` clears it explicitly), plus an automatic clear when leaving
  `failed` (FR-018 re-trigger). Covered by a new test that pre-seeds `last_error`, transitions into
  `failed` with no option, and asserts the diagnostic survives. Suite: 30 tests passing.

### F7 — A fresh service-role client is constructed on every call

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/digest/run-state.ts (all five exports; `transitionDigest` allocates twice — once directly, once via `resumeDigest`)
- **Detail**: Every run-state call invokes `createServiceClient()`, allocating a new supabase-js client. This mirrors `src/lib/supabase.ts`, where a per-request factory is correct because the SSR client closes over request cookies — but the service-role client holds no per-request state, so the shape is copied rather than required. Harmless at the current call volume; relevant once the S-01 worker loops over articles.
- **Fix**: Memoize the client in module scope inside `src/lib/supabase-admin.ts`, keeping the `null`-when-unconfigured contract.
- **Decision**: FIXED — `src/lib/supabase-admin.ts` now caches the client in module scope
  (`cached ??= createClient(...)`) with a comment contrasting it against the per-request SSR client.
  Call sites and the `null`-when-unconfigured contract are unchanged. Lint, `astro check`, and the
  30-test suite all pass afterwards.

### F8 — No constraint that `window_end >= window_start`

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260722173032_digest_core_schema.sql (digest table)
- **Detail**: `createDigest` forwards two date strings unvalidated, and the schema accepts any pair. The partial unique index keys on `window_start` alone, so a transposed or mistyped window silently produces a well-formed run for the wrong week — the kind of error that surfaces days later as "the digest covered the wrong articles". The plan did not call for this constraint; noting it because the schema is otherwise carefully guarded.
- **Fix**: Add `check (window_end >= window_start)` to `digest` in a follow-up migration.
- **Decision**: SKIPPED — deliberately deferred to be handled together with F1. Adding a second
  migration while the migration history is already out of sync would compound that problem; revisit
  once the project is linked and `db push` is the working delivery path.

### F9 — Additions beyond the plan's Changes Required

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: multiple
- **Detail**: The diff contains work the plan does not describe: FK indexes `cluster_digest_id_idx` / `article_digest_id_idx` / `article_cluster_id_idx` (P1); an eslint ignore for the generated types (P2); `src/types.ts`, `test/shims/astro-env-server.ts`, the CLAUDE.md commands entry, and `transitionDigest`'s optional `{ lastError }` parameter (P3). Each is defensible — the shim is required for Vitest to resolve `astro:env/server` at all, `src/types.ts` follows CLAUDE.md's own convention, and the extras were disclosed at the time — and none crosses a "What We're NOT Doing" boundary. Flagged so the plan is not later mistaken for a complete description of the diff.
- **Fix**: None required; optionally add a short addendum to plan.md recording these so a future reader reconciling plan against diff is not surprised.
- **Decision**: FIXED — an "Addendum (post-implementation, 2026-07-24)" section was added to
  plan.md above the Progress section, recording the two deviations (cloud-vs-local test target, the
  unrun `db reset` and its migration-history consequence), the six undescribed additions, and the
  fixes applied during this triage.
