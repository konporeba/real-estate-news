<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Reliable Scheduler Backbone (F-05)

- **Plan**: context/changes/reliable-scheduler-backbone/plan.md
- **Scope**: All 4 phases (full plan)
- **Date**: 2026-07-29
- **Verdict**: NEEDS ATTENTION (at review time) → **APPROVED** (after triage — F1 fixed and verified)
- **Findings**: 1 critical (fixed), 0 warnings, 0 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Uncaught exception in a job action leaks a stuck, undiagnosed claim

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/worker/scheduled-run.ts:87 (also src/worker/scheduled-run.ts:29-37, `runCollectionJob`)
- **Detail**: `const outcome = await actions[job.name]();` has no try/catch, and `runCollectionJob` calls `runCollect()`/`runRank()` directly with no try/catch either. Both `collect.ts`'s `main()` (throws `CollectRefused` for a digest already past collection, or a plain `Error` via its `unwrap()` helper) and `rank.ts`'s `main()` (same `unwrap()` pattern) can throw — expected and handled today only because the CLI entrypoints' own `import.meta.url` guard catches it. Inside `runScheduledJobs`, such a throw skips the `releaseJob` call entirely (lines 89-95), leaving `scheduled_job.status = 'running'` with `last_fired_at` still null and no `last_error` recorded. The job reports as perpetually running — with every subsequent 15-minute tick logging a misleading "already running" (contention) message rather than the real cause — until `DEFAULT_STALE_AFTER_MS` (3h) elapses and a later invocation stale-reclaims it, at which point the original error's detail is gone (never written to `scheduled_job.last_error`, the table's designed diagnostic surface). Verified directly: `collect.ts` throws `CollectRefused` (lines 60, 108) and a plain `Error` via `unwrap()` (line 37); `rank.ts` throws via the same `unwrap()` pattern (line 36); neither is caught anywhere between the action call and `releaseJob`.
- **Fix**: Wrap the `await actions[job.name]()` call in `runScheduledJobs` in try/catch, converting any thrown error into `{ ok: false, error: String(error) }` so `releaseJob` always runs — matching the "no scheduler-level retry, but every outcome including failure is recorded and diagnosable" design intent already stated in the plan.
- **Decision**: FIXED — a real `try`/`catch` (not `.catch()` promise-chaining, which would miss a `JobAction` that throws synchronously rather than returning a rejected promise) now wraps the action call in `src/worker/scheduled-run.ts`. Added a regression test (`releases the claim and records the error when the action throws`) to `src/worker/scheduled-run.test.ts`, exercising a synchronously-throwing action specifically. Full suite re-run: 259/259 passed (up from 258, the new test), `npm run lint` clean, no regressions.

## Verification performed

- **Automated**: `npm run lint` — pass (no errors). `npm test` (against local Docker Supabase stack, `SUPABASE_TEST_PROJECT=1`) — 258 passed, 11 skipped (opt-in live-smoke suites), 0 failures. `npx vitest run src/lib/scheduler/schedule.test.ts` re-run independently by the safety-review agent — 8/8 pass, including the DST spring-forward (2026-03-29) and fall-back (2026-10-25) transition assertions.
- **Manual**: all Manual Progress rows across Phases 1, 3, and 4 are `[x]` with commit SHAs. Phase 1's row 1.1 and Phase 4's rows 4.2/4.3 explicitly record two carried-forward gaps rather than overclaiming: the migration is applied to a local Docker stack only (cloud project access was blocked this session — CLI 403 + MCP wrong-account, same class of issue as F-01/F-03), and the systemd units are reviewed but not run on real hardware. No rubber-stamping detected — every checked manual item has either direct evidence in the diff/test output or an honestly-recorded caveat.
- **Plan drift**: a dedicated sub-agent verified all 12 planned deliverables (migration, types, store, core due-check math, registry, entrypoint, npm script, systemd artifacts, docs) against the actual files — all MATCH, no DRIFT, no MISSING, no unplanned EXTRA files. The "What We're NOT Doing" scope boundary (no S-08 publish job, no heartbeat/alerting, no dashboard view) is respected.
- **Safety/quality**: a second sub-agent independently reviewed the migration's grant/RLS posture (matches the `increment_digest_cost` precedent exactly), the claim/release race-safety (the atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING SETOF` is correct Postgres semantics; the scoped release correctly prevents a stale-reclaimed slow run from clobbering a fresher claim), the DST math (independently re-verified correct, and confirmed `schedule.ts`'s deliberate duplication of `window.ts`'s technique is algorithmically identical, not a divergent reimplementation), and pattern consistency against `run-state.ts`/`collect.ts`/`rank.ts`. F1 above was this agent's one substantive finding.
