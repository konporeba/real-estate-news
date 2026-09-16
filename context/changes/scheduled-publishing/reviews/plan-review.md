<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Scheduled Publishing (S-08)

- **Plan**: `context/changes/scheduled-publishing/plan.md`
- **Mode**: Deep
- **Date**: 2026-09-13
- **Verdict**: SOUND (after fixes; REVISE before)
- **Findings**: 2 critical, 2 warning, 2 observations — all fixed

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | WARNING → PASS (after F2 fix) |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | FAIL → PASS (after F1, F3, F4, F5 fixes) |
| Plan Completeness | WARNING → PASS (after F1, F2 fixes) |

## Grounding

15/15 referenced paths exist, all cited symbols confirmed (`selection_platform` enum, `generated_asset.digest_id` direct FK, `ASSET_BUCKET`/`SIGNED_URL_TTL_SECONDS`, digest transition table incl. `approved→published`/`skipped→published`), brief↔plan consistent, Progress↔Phase mapping fully consistent (no malformed sections).

## Findings

### F1 — Caption/image story order was unspecified, and no natural DB column backs it

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 2 (caption.ts), Phase 3 (runPublish)
- **Detail**: `generated_copy`/`selection_item` have no rank column; `src/lib/generation/generate.ts` reads picked clusters with no `ORDER BY` at all. `generated_asset` DOES have a deterministic order (`slide_index`, fixed at render time). Composing captions from an independently-ordered `generated_copy` query risked a carousel's caption text listing stories in a different order than the images show them.
- **Fix**: Derive caption order from `generated_asset.slide_index` (walk the same slide-ordered query already used for images, look up each non-cover row's `cluster_id` in `generated_copy`) instead of querying `generated_copy` independently.
- **Decision**: FIXED (applied)

### F2 — The manual-publish path was unreachable from where operators actually land

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment / Plan Completeness
- **Location**: Phase 5
- **Detail**: `src/pages/dashboard/[id].astro` only links to `/approve` (where Phase 5 puts the "Publish now" panel + results) for `ready_for_approval`/`approved`/`rejected` — never for `skipped` or `published`, exactly the two statuses this slice's manual-publish and result-viewing exist for.
- **Fix**: Extend `[id].astro`'s status conditional to also link to `/approve` for `skipped` and `published`; added as a new Phase 5 Changes Required item (#6) plus matching success criteria and Progress item 5.6.
- **Decision**: FIXED (applied)

### F3 — Instagram container processing is asynchronous; no polling step was specified

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 2 (Instagram publisher)
- **Detail**: Meta's Graph API media containers start `IN_PROGRESS` and must reach `FINISHED` before `/media_publish` succeeds (premature publish fails with error 9007). The plan's contract had no polling step.
- **Fix**: Added "poll container `status_code` until `FINISHED` (bounded retries/timeout) before calling `/media_publish`" to the Instagram publisher's contract, plus matching test coverage in Phase 2's success criteria.
- **Decision**: FIXED (applied)

### F4 — LinkedIn organization posting likely needs its own access approval, unflagged

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Critical Implementation Details / plan-brief Open Risks
- **Detail**: LinkedIn organization-page posting generally requires the Community Management API product — an application/review process with external lead time, structurally identical to S-06's Canva access dependency (OQ#2). Undocumented, this would only surface at Phase 6's dry run, potentially blocking the whole slice.
- **Fix**: Added as an explicit risk in both `plan.md`'s Critical Implementation Details and `plan-brief.md`'s Open Risks & Assumptions, so the operator can file the request early.
- **Decision**: FIXED (applied)

### F5 — Signed URL TTL was designed for browser-immediate-fetch, reused for async external fetch

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 (assets.ts)
- **Detail**: `SIGNED_URL_TTL_SECONDS` (600s) is documented as sized for "the browser fetching images on a page it just loaded" — a different consumer than Meta's servers fetching asynchronously after the API call returns. Probably fine, but the rationale doesn't transfer.
- **Fix**: Publish path uses its own longer, locally-defined TTL constant (`PUBLISH_SIGNED_URL_TTL_SECONDS`) rather than assuming the browser-page default holds; added a Phase 6 manual-verification step (and Progress item 6.3) to confirm no image-fetch/expired-URL errors occur during the real dry run.
- **Decision**: FIXED (applied)

### F6 — Current State Analysis cited the wrong precedent for "client as parameter"

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness / Plan Completeness
- **Location**: Key Discoveries
- **Detail**: The plan cited `src/lib/approval/rules.ts` as an example of "takes Supabase client as a parameter"; it actually makes no Supabase calls at all (pure validation).
- **Fix**: Corrected the citation to `src/lib/digest/run-state.ts`'s `createDigest(client, window)`.
- **Decision**: FIXED (applied)
