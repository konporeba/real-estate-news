<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Archive & Learning Loop (S-09)

- **Plan**: context/changes/archive-and-learning-loop/plan.md
- **Scope**: Full plan (Phases 1-6)
- **Date**: 2026-09-19
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Roadmap's S-09 Status field stuck at "proposed"

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: context/foundation/roadmap.md:272 (S-09 entry), :45 (at-a-glance table), :303 (backlog handoff table)
- **Detail**: Phase 6's contract only required striking through OQ#5 (done correctly). It didn't call out updating S-09's own `Status:` field, so it stayed `proposed` in all three places even after `change.md`/`plan.md` were flipped to `implemented` in the epilogue commit (`0fe5cfd`). Not drift against the stated contract — just an inconsistency.
- **Fix**: Update all three Status fields to `done`/`shipped` with the commit range, matching the convention used by every other shipped slice (e.g. S-08's entry).
- **Decision**: FIXED (applied directly per explicit user request, commit pending)

### F2 — `dashboard.astro`'s `before` cursor param has no format validation

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/dashboard.astro:30
- **Detail**: `if (before) query = query.lt("window_start", before)` passes the raw query param straight to the Supabase query builder — not injectable (parameterized), but a malformed value surfaces as a generic 500 rather than a friendlier "bad cursor" response. Consistent with the rest of the file's error handling, so not a regression.
- **Fix**: Optionally validate `before` as a date-shaped string before querying and fall back to the unfiltered first page on a bad value.
- **Decision**: FIXED — `src/pages/dashboard.astro` now validates `before` against `/^\d{4}-\d{2}-\d{2}$/` before use, falling back to `null` (unfiltered first page) on a malformed value.

### F3 — Few-shot article text embedded verbatim into the LLM prompt

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/ranking/rubric.ts (buildRubricSystemPrompt) / src/lib/ranking/few-shot.ts
- **Detail**: Real, unescaped external article titles/ledes/rationale are embedded into the LLM system prompt as few-shot examples — a theoretical prompt-injection surface. Requires the text to have first passed a human pick/pass decision, and it's the same trust model `buildScoringPrompt` already uses for every cluster today. Not a new risk introduced by S-09.
- **Fix**: No action needed; noted for awareness only.
- **Decision**: ACCEPTED — same pre-existing trust model as `buildScoringPrompt`; no code change.

## Additional notes (not findings)

- Both parallel review agents independently confirmed all 15 changed/new files MATCH their phase's plan Contract exactly, including the 5 specific constraint checks called out for Phase 4/5 (empty-few-shot returns `GEOGRAPHY_RUBRIC_SYSTEM` byte-unchanged; few-shot fetched once per `rankDigest` call, not per batch; `RANKING_FEWSHOT_ENABLED` uses `z.enum(["0","1"])` not `z.coerce.boolean()`; a few-shot fetch failure fails the digest via `failDigest` like a scoring failure; no scope creep beyond the plan's file list).
- Success criteria re-verified independently during this review: `few-shot.test.ts` + `rubric.test.ts` (6 tests), `disjointness.test.ts` + `harness.test.ts` (9 tests) all pass. Full suite (710 passed), `RANKING_EVAL=1` live gate, typecheck (7 pre-existing unrelated errors, confirmed via diff against pre-change HEAD), lint (0 errors), and production build were all verified green during Phase 5/6 execution.
- `eval/disjointness.ts` correctly imports only pure data (`eval/examples.ts`) and a type-only import from `few-shot.ts` — safe for either runtime, does case/whitespace-insensitive title matching as required.
