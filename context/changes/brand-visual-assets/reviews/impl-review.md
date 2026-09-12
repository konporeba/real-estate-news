<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Brand Visual Assets (S-06)

- **Plan**: context/changes/brand-visual-assets/plan.md
- **Scope**: Phases 1–7 of 7 (full plan)
- **Date**: 2026-09-12
- **Verdict**: APPROVED (triaged 2026-09-12 — 3 fixed, 2 accepted)
- **Findings**: 0 critical, 1 warning, 4 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | WARNING |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

## Findings

### F1 — A lost batchUpdate response leaves an untracked page and defeats the retry

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/visuals/render.ts (`renderPage`, `created.add(pageId)` after the fill batch; `finally` sweep in `renderDigest`)
- **Detail**: `created` is the set both the `finally` sweep and the retry's pre-delete guard read, and a
  page id is added to it only _after_ `batchUpdate` returns success. If the duplicate is applied
  server-side but the response never arrives (connection reset, timeout — `authorizedFetch` maps both
  to `api_error`), the page exists in the operator's deck while `created` says it does not. One
  failure then causes two problems: the `finally` sweep does not delete the page, and the retry's
  `created.has(pageId)` guard is false so it skips its pre-delete and `duplicateObject` fails with a
  duplicate-id error. The retry is defeated exactly when it was meant to help, and the digest lands in
  `failed` with a stray page left behind until some later run's prefix sweep collects it. Self-healing
  and not data-destroying, but it turns one transient blip into a failed week.
  A second, related weakness: the sweep deletes every tracked id in a _single_ `batchUpdate`, so one
  stale or already-deleted id fails the whole batch and leaves the genuinely-created pages behind.
- **Fix**: Add `pageId` to `created` _before_ issuing the fill batch, and have the `finally` sweep
  delete ids one at a time rather than in one batch.
  - Strength: Tracking optimistically is strictly safer — the ids are deterministic, a delete of a
    page that was never created is a harmless ignored failure, and both the retry's pre-delete and the
    sweep then behave correctly in the lost-response case. Per-id deletes stop one bad id from
    blocking the cleanup of good ones.
  - Tradeoff: Up to five extra API calls per failed run, and one expected-to-fail delete in the
    narrow case where the page truly was not created.
  - Confidence: HIGH — the mechanism is visible in the code, and the `finally` block already treats
    cleanup as best-effort, so making it more granular changes no contract.
  - Blind spot: Not reproduced live; Slides `batchUpdate` is documented as validating before applying,
    so this window is specifically the dropped-response case rather than a partially-applied batch.
- **Decision**: FIXED — `created.add(pageId)` moved ahead of the fill batch and the sweep now deletes one id at a time. Covered by a new regression test (`clears the page id before retrying a fill that failed`) which was confirmed to FAIL against the pre-fix code and pass against the fix.

### F2 — Storage failures are reported with the `database_error` reason

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/visuals/render.ts (failure classification in `renderDigest`)
- **Detail**: `RunStateErrorReason` has no storage member, so a Supabase Storage outage surfaces as
  `{ reason: "database_error", message: "storage upload to digest-assets/… failed: …" }`. The message
  is explicit and the worker prints reason and message together, so the operator is not misled in
  practice — but a programmatic caller branching on `reason` cannot tell Postgres from Storage.
- **Fix**: Leave as is, or add a `storage_error` member to `RunStateErrorReason`. No caller branches
  on the reason today, so this is a judgement call rather than a defect.
- **Decision**: FIXED — `storage_error` added to `RunStateErrorReason`; `renderDigest` now uses it, and the storage-outage test pins the reason rather than only the message.

### F3 — Phase 7 introduced two changes beyond the tier table it was scoped to

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: vitest.config.ts, CLAUDE.md
- **Detail**: The plan states "Tier-table adjustments made here are the only code change this phase may
  introduce." Two other changes landed: `vitest.config.ts` gained `GOOGLE_`/`SLIDES_` in its `loadEnv`
  prefix list, without which the phase's own live smoke test could never see the credentials and would
  have silently skipped itself forever; and `CLAUDE.md` gained the live-smoke entry plus a correction
  to all four worker commands' flag syntax (`npm run <worker> --digest=…` is swallowed by npm and
  silently targets a different digest). Both are justified and explained in their commit messages, and
  neither touches stage behaviour — flagged because the guardrail was explicit.
- **Fix**: None needed; recorded so the deviation is visible rather than silent.
- **Decision**: ACCEPTED — both changes were required by the phase's own deliverable (the live test cannot read credentials without the loadEnv prefixes) and are explained in their commit messages.

### F4 — Deterministic page ids make concurrent runs against one deck unsafe

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/lib/visuals/render.ts (`renderPageId` / `renderTitleId`)
- **Detail**: Page ids are `renderx<slideIndex>p`, derived only from the slide index, so two
  simultaneous `npm run visuals` runs against the same deck would collide on ids and sweep each
  other's pages. This is a deliberate trade — deterministic ids are what make a crashed run's
  leftovers identifiable — and the stage is manual, single-operator, and documented as such in the
  module header. It only becomes real if a future change puts rendering on the scheduler.
- **Fix**: None now. If S-08 or a later slice ever schedules this stage, add a per-run token to the
  prefix and sweep by prefix rather than by exact id.
- **Decision**: ACCEPTED — deliberate trade, argued in the module header. Revisit if a later slice schedules this stage.

### F5 — The carousel path has never run against the real carousel deck

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: context/changes/brand-visual-assets/verification.md
- **Detail**: Digest `c92aa3c5`'s selection is `single_post`, so the live verification exercised only
  that deck. The carousel path is covered by integration tests against a fake transport (cover slide,
  slide-index offset, per-page scoping), and the carousel deck passes the validator — but its story
  slide still carries Slides' default 236 × 32 pt text boxes, which is exactly the geometry that
  produced overlapping text on the single-post deck. The first carousel week will reproduce that
  defect unless the deck is resized first. This is recorded in `verification.md`, not hidden.
- **Fix**: Apply the same geometry pass to the carousel deck's story slide (and size the two cover
  boxes) before the first week the operator chooses the carousel format.
- **Decision**: FIXED — the carousel deck's cover and story slides were given the same geometry pass as the single-post deck (transforms saved for revert); `npm run visuals:validate` still exits 0 for both decks.

## Evidence

- `npm test` — 48 files passed, 6 skipped, 569 passed, 13 skipped, 0 failures
- `npm run build` — clean
- `npm run lint` — 0 errors (11 `no-console` warnings, the repo's existing convention)
- `SLIDES_LIVE_SMOKE=1 npx vitest run src/lib/visuals/slides.live.test.ts` — passed against the real deck
- `npm run visuals:validate` — exit 0, both decks conform
- Live run state confirmed in the database: `rendering_completed_at` stamped, 4 `generated_asset`
  rows, exactly 4 objects in the bucket (no orphans), digest in `ready_for_approval`
- Both decks re-read after the run: 0 leftover `renderx*` pages, all placeholders intact
