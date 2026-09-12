<!-- PLAN-REVIEW-REPORT -->

# Plan Review: Content Approval Gate (S-07)

- **Plan**: `context/changes/content-approval-gate/plan.md`
- **Mode**: Deep
- **Date**: 2026-09-12
- **Verdict**: REVISE → **SOUND** after fixes
- **Findings**: 1 critical, 2 warnings, 2 observations — all applied

## Verdicts

| Dimension             | Verdict (at review) | After fixes |
| --------------------- | ------------------- | ----------- |
| End-State Alignment   | FAIL                | PASS        |
| Lean Execution        | PASS                | PASS        |
| Architectural Fitness | PASS                | PASS        |
| Blind Spots           | WARNING             | PASS        |
| Plan Completeness     | WARNING             | PASS        |

## Grounding

10/10 paths ✓, 1/1 symbols ✓ (`isSafeUrl` confirmed exported from `@/lib/utils`, used at
`src/components/ShortlistCard.tsx:11,115`), brief↔plan ✓.
Progress↔Phase contract verified mechanically after fixes: all 7 phases match
(A5/M4, A4/M2, A4/M3, A3/M7, A5/M2, A6/M4, A2/M6), 0 stray checkboxes outside `## Progress`,
exactly 1 `## Progress` heading.

## Findings

### F1 — `npm run generate` cannot recover a rejected digest

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — the fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment
- **Location**: Desired End State; Phase 1; Progress 7.6
- **Detail**: The plan promises "from which `npm run generate` can produce fresh copy on the same
  confirmed selection", and Progress 7.6 tests it. But `resolveTargetDigest`
  (`src/worker/generate.ts:78-100`) accepts only `generating`, plus `failed` as a single explicit
  exception, and throws `GenerateRefused` for anything else — a `rejected` digest hits
  `digest ... is in "rejected", not "generating"`. No phase touched `generate.ts`, so the recovery
  path the entire reject decision rests on did not exist. A promise with no backing phase.
- **Fix**: Added Phase 1 change #5 extending `resolveTargetDigest`'s explicit-`--digest` exception to
  cover `rejected`, reusing the existing `hasConfirmedSelection` guard (a rejected digest always has
  one, having reached the gate through generation) and preserving the never-implicit rule. Added
  automated row 1.2 (`generate.test.ts`) and manual row 1.9.
- **Decision**: FIXED

### F2 — A rejected digest silently loses its visuals

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 4, change #4
- **Detail**: `RENDERED_STATUSES` (`src/pages/dashboard/[id].astro:20`) lists
  rendering / ready_for_approval / approved / published. A `rejected` digest falls through to the
  post-selection `Fragment`, fails that test, and renders neither the asset strip nor its
  "No visuals rendered yet" fallback — the cards it really does have vanish with no explanation.
- **Fix**: Phase 4 change #4's contract now requires adding `rejected` to `RENDERED_STATUSES`, with
  manual criterion and Progress row 4.9 verifying it.
- **Decision**: FIXED

### F3 — The approve summary's data source is unnamed

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 4, change #1 vs change #3; Progress 4.6
- **Detail**: Change #3 requires the approve summary to name "story count, format and platforms, read
  from the confirmed `selection`", and 4.6 verifies it — but change #1's contract listed only
  `generated_copy`, `generated_asset` and the source articles. The implementer would discover the
  missing query only when writing the island.
- **Fix**: Change #1's contract now enumerates all four reads explicitly, including `selection`
  (`format`, `platforms`), under the same error-vs-empty discipline.
- **Decision**: FIXED

### F4 — Week-collision on recovery reports as a generic error

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1
- **Detail**: `transitionDigest` maps `CHECK_VIOLATION` and `NO_ROWS_RETURNED` but not `23505`
  (`src/lib/digest/run-state.ts:107-112`). Moving `rejected → generating` re-activates the week, so
  if another digest is live for it the operator sees `database_error` rather than "a digest already
  exists for this week". Pre-existing on the `failed → collecting` edge.
- **Fix**: Recorded as an implementer note in Phase 1 change #5, explicitly out of scope to fix —
  documented so it is not debugged from scratch.
- **Decision**: FIXED (documented)

### F5 — Phase 5 is missing the pause marker

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 5
- **Detail**: Phases 1, 2, 3, 4 and 6 carry the "pause here for manual confirmation" Implementation
  Note; Phase 5 did not, despite having manual criteria (5.6, 5.7) that gate Phase 6's email work.
- **Fix**: Added the standard Implementation Note to Phase 5.
- **Decision**: FIXED

## Triage Summary

```
  Fixed:     F1, F2, F3, F4 (documented), F5   (5)
  Skipped:   —
  Accepted:  —
  Dismissed: —

  ► Verdict after fixes: REVISE → SOUND
```
