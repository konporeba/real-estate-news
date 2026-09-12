<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Content Approval Gate (S-07)

- **Plan**: `context/changes/content-approval-gate/plan.md`
- **Scope**: Full plan (all 7 phases)
- **Date**: 2026-09-12
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 3 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | PASS    |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

## Evidence

- **Git scope**: `da20e5a^..63da127` (9 commits: 7 phase commits + epilogue + roadmap doc update). `git diff --stat` shows exactly the file set the plan calls for across all 7 phases — no stray files.
- **Automated criteria, re-run fresh**: `npm run build` → clean. `npm run lint` → 0 errors, 20 pre-existing `no-console` warnings unrelated to this change. `npm test` → 627 passed, 0 failed, 14 skipped (all `SUPABASE_TEST_PROJECT` integration suites ran live and passed, since that env is configured in this project's `.env`).
- **Manual criteria**: every Manual row across all 7 phases in `## Progress` is checked with substantive, evidence-carrying annotations — several explicitly disclose partial verification (4.6, 6.9, 7.4, 7.6, 7.7) rather than rubber-stamping. This is the intended honesty convention (`verification.md` follows the archived `S-06` template exactly, including a section for what did **not** work first time) and was checked for the rubber-stamping failure mode specifically: no manual row asserts something the diff or the live-verification record doesn't support.
- **Two independent sub-agent passes** (plan-drift detection; safety/quality/pattern compliance) each read every changed file against the plan's stated Intent/Contract and against sibling files in the codebase. Both returned zero CRITICAL/WARNING findings — an unusually clean result for a 7-phase, cross-runtime, migration-touching slice.
- **Migration correctness deep-check** (the highest-stakes part of this review, given migrations are the least reversible artifact): confirmed by direct diff that `20260912093000_approval_gate.sql`'s `enforce_digest_transition()` preserves all 9 prior transition clauses verbatim from `20260908140000_visual_assets.sql`, adding exactly the two documented ones. Confirmed the `one_active_digest_per_week` redefinition is real executable SQL (`drop index` + `create unique index ... where status not in ('published', 'skipped', 'failed', 'rejected')`), not merely described in a comment — the exact failure mode this project's own drift-guard parser is vulnerable to, and which bit this implementation once already during Phase 1 (self-corrected before commit, per the plan's own Critical Implementation Details).

## Findings

### F1 — `approve.astro`/`[id].astro` use "set flag, continue" rather than early-return on query error

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/pages/dashboard/[id]/approve.astro:46-155`, `src/pages/dashboard/[id].astro` (pre-existing pattern, unchanged by this feature)
- **Detail**: The plan's own Phase 4 contract calls out this codebase's known footgun explicitly: "Every query failure must **return or guard**, never merely set a flag and fall through." The actual code sets `loadError = true` on a query error and _continues executing_ subsequent queries (e.g. the `article` query still runs after a `copyError`), rather than returning immediately. Traced through: every downstream array defaults via `?? []`, and the render ternary checks `loadError` before any branch that would index into `stories`/`assets` — so the specific bug class (indexing into empty data after an unreturned error) does not occur here. The plan's own phrasing ("return **or guard**") explicitly permits this softer pattern, and it matches the pre-existing `[id].astro`'s own style.
- **Fix**: No code change needed. Worth a one-line comment at the render-ternary's `loadError` check (in both files) noting that its position — checked before any data-touching branch — is load-bearing, so a future edit that reorders the ternary would silently reintroduce the exact bug class this codebase's own history warns about.

### F2 — `src/lib/approval/` isn't named in CLAUDE.md's two-runtime file lists

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: `CLAUDE.md` ("Two runtimes" section), `src/lib/approval/outstanding.ts`, `src/lib/approval/rules.ts`
- **Detail**: `outstanding.ts` documents itself correctly as shared code (client passed as a parameter, no Node-only imports, consumed by both `src/worker/remind.ts` and — potentially — future app-side callers), following the exact convention `src/lib/digest/` and `src/lib/supabase-service.ts` already establish. `rules.ts` is app-side-only. CLAUDE.md's "Two runtimes" section doesn't mention `src/lib/approval/` in either runtime's file list, so a future contributor has no documented signal that this one directory holds a mix, unlike `src/lib/email/`/`src/lib/scheduler/` which are unambiguously worker-only. No actual boundary violation exists (confirmed by grep against `eslint.config.js`'s `no-restricted-imports` groups and every app-side import).
- **Fix**: Add one line to CLAUDE.md's "Two runtimes" section noting `src/lib/approval/outstanding.ts` follows the shared-code convention (like `src/lib/digest/`), while `src/lib/approval/rules.ts` is app-side-only.

### F3 — `ApprovalStory` landed in `src/types.ts` during Phase 2, ahead of Phase 4's stated need

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/types.ts:271-292`
- **Detail**: Phase 2's contract for `src/types.ts` names only `ApprovalRow`, `ApprovalDecision`, and `ApprovalErrorReason`. `ApprovalStory` — the view-model interface `GeneratedStoryCard.astro` consumes — is also present, added instead during Phase 4 (per its own commit) to work around a real, documented constraint: the type-aware linter cannot resolve member access on an interface exported from a `.astro` file, so it was relocated to `src/types.ts` to match the `ShortlistItem` precedent. This is correctly attributed in the plan's Phase 4 section and in the commit message — not scope creep, just filed under a different phase's file heading than a first read of Phase 2 alone would suggest.
- **Fix**: No action needed — already correctly documented at the point of the actual change. Noted here only so a reader diffing "Phase 2's `types.ts` changes" in isolation isn't confused by the extra interface.

## Summary

This is a clean implementation: zero drift across ~30 planned changes spanning two runtimes, three migrations, a new HTTP endpoint, a new hydrated island, two new outbound emails, and a new scheduled job. The one genuinely high-stakes surface — the migration touching the transition trigger and the partial unique index — was independently verified byte-for-byte correct by a dedicated deep-check pass. All three findings are observations with no required action before merge.
