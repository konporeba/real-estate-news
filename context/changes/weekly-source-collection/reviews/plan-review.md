<!-- PLAN-REVIEW-REPORT -->

# Plan Review: Weekly Source Collection

- **Plan**: context/changes/weekly-source-collection/plan.md
- **Mode**: Deep
- **Date**: 2026-07-24
- **Verdict**: REVISE → **SOUND after triage** (all 5 findings fixed in the plan on 2026-07-24)
- **Findings**: 1 critical, 2 warnings, 2 observations

## Verdicts

| Dimension             | Verdict |
| --------------------- | ------- |
| End-State Alignment   | FAIL    |
| Lean Execution        | PASS    |
| Architectural Fitness | WARNING |
| Blind Spots           | WARNING |
| Plan Completeness     | WARNING |

Verdicts above are as-reviewed. All five findings were fixed during triage, so every dimension now passes; Progress grew from 34 to 36 rows (new criteria for week resolution and runtime-boundary linting) and re-verified clean against the format contract.

## Grounding

8/8 paths ✓, 4/4 symbols ✓, brief↔plan ✓. Progress contract clean: one `## Progress` heading, five `### Phase N:` blocks matching the body phase names, 34 rows covering every Success Criteria bullet, no checkbox leakage into phase blocks. Blast-radius claim ("the only current callers are the F-01 tests") verified — `src/lib/digest/run-state.test.ts:22-23` is the sole importer of both changed modules.

## Findings

### F1 — Default week resolution defeats the recovery path the slice exists for

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Phase 5 — Collection entrypoint
- **Detail**: The entrypoint "resolves the target week (defaulting to the current Monday–Sunday, overridable by a `--week=YYYY-MM-DD` flag)". But US-02's scenario is "the Sunday run failed or the machine was offline → I open the dashboard and trigger the run manually" — which in practice happens **Monday or later**, once the operator notices the missing email. At that point "the current Monday–Sunday" is the *new* week, so the default run creates a fresh digest for a week that has barely started, leaves the failed digest untouched, and produces a near-empty pool. The FR-018 recovery the whole slice is built around only works if the operator remembers to pass `--week` with the right Monday. The plan's own Phase 5 contract already handles `failed` digests — but only for the week it resolved, which is the wrong one.
- **Fix A ⭐ Recommended**: Default to the most recent recoverable digest, not the calendar week — look for the newest non-terminal or `failed` digest first and target it; fall back to the current Monday–Sunday only when none exists. Keep `--week` as the explicit override.
  - Strength: Makes the common recovery path correct with no flag, which is the entire point of FR-018; the query is a single `order by window_start desc limit 1` against columns that already exist.
  - Tradeoff: A run intended to start a *new* week while an old failed digest lingers would target the old one instead — mitigated by printing the resolved week and requiring `--week` to override.
  - Confidence: HIGH — `getActiveDigestForWeek` and the `failed → collecting` transition already exist; this is resolution logic, not new capability.
  - Blind spot: Behavior when several failed digests are stacked up is unspecified; picking the newest is an assumption.
- **Fix B**: Keep the calendar default but refuse to run when a `failed` digest exists for any earlier week, printing the exact `--week` command to recover it.
  - Strength: Never guesses; the operator stays in control and is told precisely what to type.
  - Tradeoff: Recovery still needs a second command, and a stale failed digest from months ago would block a normal run until cleared.
  - Confidence: MEDIUM — safe, but it trades a silent wrong action for a hard stop the operator must resolve.
  - Blind spot: How a permanently-abandoned failed week gets dismissed is undefined.
- **Decision**: FIXED via Fix A — Phase 5's contract now resolves in the order `--week` → newest
  recoverable digest → new current-week digest, always printing the resolved week, with the
  rationale recorded inline. Added change 1a (`getLatestRecoverableDigest` on run-state, since
  `getActiveDigestForWeek` is keyed to a single week) plus a week-resolution test criterion (new
  Progress row 5.2; manual rows renumbered to 5.5–5.8).

### F2 — Entrypoint contract omits the `collecting` state, which is exactly what a killed worker leaves behind

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 5 — Collection entrypoint; Progress row 5.7
- **Detail**: The entrypoint contract enumerates three cases: no digest (create), `failed` (transition back to `collecting`), and past `ranking` (refuse). It never says what to do when the digest is already in `collecting` — which is precisely the state a worker killed mid-run leaves behind, and the state Progress row 5.7 ("Worker killed mid-run recovers the week on re-run with no lost articles") tests. An implementer reading the contract literally has no instruction for the case the success criteria explicitly check.
- **Fix**: Add the `collecting` case to the Phase 5 contract — proceed directly to the orchestrator, which tops up the existing pool. Note that no transition is needed since the digest is already in the right state (and `canTransition` would reject a self-transition anyway).
- **Decision**: FIXED — the Phase 5 contract now enumerates all four states as an explicit
  status-driven branch (absent → create, `failed` → re-trigger, `collecting` → straight to the
  orchestrator, past `ranking` → refuse), with the killed-mid-run rationale inline.

### F3 — Phase 4's database-backed criteria can pass by silently skipping

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 4 — Success Criteria (4.2–4.5); Testing Strategy
- **Detail**: The Testing Strategy correctly marks the isolation, escalation, top-up and state tests as "Integration Tests (against the configured Supabase project, opt-in)", but Phase 4's Automated Verification lists them as plain criteria with no mention of the opt-in. Following the F-01 precedent, `npm test` without `SUPABASE_TEST_PROJECT=1` reports those tests as *skipped*, not failed — so an implementer can run `npm test`, see green, and tick 4.2–4.5 having verified nothing. This is the same vacuous-pass trap the F-01 implementation review raised as finding F5.
- **Fix**: State the opt-in explicitly in the Phase 4 criteria — e.g. "`SUPABASE_TEST_PROJECT=1 npm test` (these are integration tests; without the flag they skip rather than fail)" — and mirror the note on the corresponding Progress rows.
- **Decision**: FIXED — Phase 4's Automated Verification now opens with a callout that the four
  database-backed criteria skip rather than fail without `SUPABASE_TEST_PROJECT=1`, and Progress
  rows 4.2–4.5 each carry the flag requirement inline.

### F4 — Collection code under `src/lib/` puts Node-only dependencies one import away from the Cloudflare build

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 — file layout and `rss-parser` dependency
- **Detail**: The plan puts collection code in `src/lib/collection/` and adds `rss-parser` as a runtime dependency, while the Astro app still builds with `@astrojs/cloudflare` (workerd). Nothing breaks today because no page imports collection code — but the boundary is convention, not structure. The first dashboard page that imports anything from `src/lib/collection/` (plausibly a future collection-report panel) pulls a Node-oriented parser into the workerd bundle. The plan documents the rule for `src/worker/` ("must not import `astro:env/server`") but states no reciprocal rule keeping worker-side dependencies out of the app bundle.
- **Fix**: Add the reciprocal constraint to the Phase 5 CLAUDE.md change — `src/lib/collection/` is worker-side and must not be imported from `src/pages/` or any React island — and consider an ESLint `no-restricted-imports` rule to make it enforced rather than remembered.
- **Decision**: FIXED (doc + lint rule) — Phase 5 gains a new change 4 covering `eslint.config.js`
  with bidirectional import restrictions, the CLAUDE.md change now documents both directions and
  points at the rules as enforcement, and a new criterion (Progress row 5.4) verifies the rules
  actually fire by attempting a cross-runtime import in each direction. Manual rows renumbered
  to 5.6–5.9.

### F5 — Phase 2 removes a failure reason without naming the file that declares it

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Changes Required
- **Detail**: The Phase 2 contract says "the `not_configured` result and the `createServiceClient` import are removed" and then that "`RunStateResult` and the remaining failure reasons are unchanged". But `not_configured` is declared in `src/types.ts:32` as a member of `RunStateErrorReason`, with documentation at `src/types.ts:24` — a file the phase's Changes Required never lists. Removing the reason is itself a change to that type, so the two sentences pull against each other and the implementer is left to discover the third file.
- **Fix**: Add `src/types.ts` to Phase 2's Changes Required (drop `not_configured` from `RunStateErrorReason` and its doc line) and reword the contract to say the remaining reasons are unchanged rather than the type as a whole.
- **Decision**: FIXED — Phase 2 gains change 1a naming `src/types.ts` with the exact lines to edit
  (`:32` for the union member, `:24` for its doc line), and the contradictory sentence now reads
  "The `RunStateResult` shape and every remaining failure reason are unchanged."
