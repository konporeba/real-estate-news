<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Translated Shortlist View

- **Plan**: context/changes/translated-shortlist-view/plan.md
- **Scope**: Phase 1-3 of 3 (full plan)
- **Date**: 2026-07-30
- **Verdict**: REJECTED (one CRITICAL, trivially fixable)
- **Findings**: 1 critical, 3 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Findings

### F1 — Unvalidated `source_url` rendered as a clickable link

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/pages/dashboard/[id].astro:145-153`
- **Detail**: `item.sourceUrl` comes from `article.source_url` — scraped RSS content, not app-controlled input — and is rendered directly as `<a href={item.sourceUrl}>` with no scheme validation. This codebase already identified and mitigated exactly this risk once: `src/lib/email/layout.ts:79-82` has an `isSafeUrl()` check (`^https?:\/\//i`) specifically so a `javascript:`/`data:` URI from a compromised or malicious feed can't reach a clickable link. This new page skipped that guard. Note: `email/layout.ts` is worker-side-only per the two-runtime boundary (`CLAUDE.md`), so the fix can't import it directly — it needs an inline or newly-shared check.
- **Fix**: Add a small inline scheme check before rendering the link (mirroring the *logic*, not the import, of `isSafeUrl()`), e.g. `const isSafeUrl = (url: string) => /^https?:\/\//i.test(url);` near the top of the frontmatter, then guard the `<a>` with `{item.sourceUrl && isSafeUrl(item.sourceUrl) && (...)}`.
- **Decision**: FIXED — added `isSafeUrl()` helper and guarded the link render

### F2 — Supabase query errors silently treated as empty state

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/pages/dashboard.astro:8-16`, `src/pages/dashboard/[id].astro:21-24, 46-64`
- **Detail**: Both new pages destructure only `.data` from every Supabase call, coercing a query error into "no rows" (`?? []` / `null`). These are the first two Astro pages that query the DB directly, so there's no existing app-side pattern being followed here — a transient Postgres error currently renders identically to "No digests yet." / "No digest with this id exists.", which is misleading for an operator trying to diagnose why nothing shows up.
- **Fix A ⭐ Recommended**: Check `error` on each call; on error, render a distinct "couldn't load digests" message (and `console.error` server-side) instead of falling through to the empty-state branch.
  - Strength: Operator gets an honest signal instead of a misleading empty state; matches the general repo convention of surfacing DB errors distinctly (e.g. `rank.ts`'s `databaseFail`).
  - Tradeoff: A few more lines per page; two more states to render.
  - Confidence: HIGH — the gap is unambiguous and the fix is mechanical.
  - Blind spot: None significant.
- **Fix B**: Leave as-is; accept that a query failure looks like an empty digest table for this internal, single-operator tool.
  - Strength: Zero additional code.
  - Tradeoff: An operator debugging "why is the dashboard empty" during a real outage has no signal it's an error, not empty data.
  - Confidence: MED — acceptable severity is a judgment call for an internal tool, not objectively wrong.
  - Blind spot: Haven't checked how often Supabase read errors actually occur in practice for this project.
- **Decision**: FIXED via Fix A — both pages now check `error` on every Supabase call, log server-side via `console.error`, set a 500 status, and render a distinct "couldn't load" message instead of falling into the empty-state branch.

### F3 — "Translated" golden-path rendering confirmed only via automated tests, not live real data

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Success Criteria
- **Location**: Plan Progress items 1.7 and 3.3 (`context/changes/translated-shortlist-view/plan.md:235, 260`)
- **Detail**: Both items are checked `[x]`, but the only real digest in the database predates this feature (ranked before `translation_completed_at` existed) and a subsequent live re-run hit a pre-existing, unrelated clustering failure before reaching translation. What's actually been observed live is the shortlist rendering with 15 real (untranslated-fallback) cards, the `failed`/not-ready/404 states, and mocked-LLM integration tests asserting `polish_title`/`polish_summary` persist correctly to the right article. The literal "operator opens a ready_for_selection digest and sees real Polish text" path has not been eyeballed. This was surfaced and explicitly accepted by the user mid-session (chose to stop rather than keep spending on retries) — recorded here for traceability, not as new information.
- **Fix**: No code fix — this is a verification gap, not a defect. Re-run `npm run collect` + `npm run rank` on a fresh/working pool whenever convenient to get the final visual confirmation; no change is expected to be needed if the two tests in F1/F2's territory (translation write path) are trusted.
- **Decision**: PENDING

### F4 — Inconsistent status code on the "Supabase not configured" branch

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/pages/dashboard.astro:8-16` vs `src/pages/dashboard/[id].astro:28-29`
- **Detail**: `[id].astro` sets `Astro.response.status = 503` when `client` is null; `dashboard.astro` has the identical "Supabase is not configured" branch but never sets a status code (stays 200). Both pages were built in this same change and should agree.
- **Fix**: Set `Astro.response.status = 503` in `dashboard.astro`'s `!client` branch too.
- **Decision**: PENDING

### F5 — `persistTranslations` writes are not atomic

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Data Safety
- **Location**: `src/lib/ranking/rank.ts:138-153`
- **Detail**: The ≤15 concurrent `.update()` calls aren't wrapped in one atomic operation, unlike `persistClusters`/`persistRanking`'s bulk RPCs. In practice this is low-risk at this scale (the plan explicitly chose plain updates over a new RPC for exactly this reason) and a partial failure still routes to a raw error (digest stays in `ranking`, never exposed via the dashboard). One second-order effect: a retry's `clearExistingClusters` clears `cluster` rows but not stale `polish_title` on `article` rows, so `dashboard/[id].astro`'s `clusterArticles.find(a => a.polish_title)` heuristic could — after a re-cluster — pick an article that carries a translation from a *previous* run's clustering, not this run's designated representative. The text shown is still a faithful translation of that article, so this is cosmetic, not a correctness bug.
- **Fix**: No action needed now. If this ever needs tightening, either clear `polish_title`/`polish_summary` alongside `clearExistingClusters`, or have `dashboard/[id].astro` key its representative lookup on the same `articleIds[0]` rule `rank.ts` uses rather than "any article with a non-null `polish_title`."
- **Decision**: PENDING

## Notes (non-findings, verified clean)

- **Authz**: `PROTECTED_ROUTES = ["/dashboard"]` in `src/middleware.ts` matches by `startsWith`, correctly covering both new pages. No bypass found.
- **Two-runtime boundary**: `translate-shortlist.ts`/`rank.ts` import only worker-side modules; the two Astro pages import only `@/lib/supabase-admin` and app-side components. No violation.
- **LLM harness**: no direct `@anthropic-ai/sdk` usage; ceiling threaded through correctly.
- **Pattern compliance**: `translate-shortlist.ts` structurally mirrors `score-clusters.ts` (system prompt constant, prompt builder, zod schema, `LlmResult` return, completeness check) with no unjustified deviation.
- **Plan adherence**: all 6 planned changes (translation module, orchestrator wiring, shared header, list page, detail page, tests) match their planned contracts. Two inert field-selection omissions (`created_at` in the list query, `source_name` in the detail query) were noted by the drift-detection pass but are unused in either render path — not functional gaps.
- **Automated success criteria** (re-verified at review time): `npm run lint` — exit 0 (1 pre-existing `no-console` warning in the live smoke test, matching the established `invoke.live.test.ts` precedent). `npm run build` — exit 0. `SUPABASE_TEST_PROJECT=1 npm test` — 265 passed, 0 failed (confirmed earlier in session).
