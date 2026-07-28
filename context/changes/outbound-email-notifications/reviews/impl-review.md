<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Outbound Email Notifications (F-04)

- **Plan**: context/changes/outbound-email-notifications/plan.md
- **Scope**: Phase 1-3 of 3 (full plan)
- **Date**: 2026-07-28
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 4 observations

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

### F1 — `bodyHtml`'s "raw HTML, caller escapes" contract is undocumented; `escapeHtml` isn't exported

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/email/layout.ts:64-71, 219 (`EmailContent.bodyHtml`)
- **Detail**: Every discrete field (`heading`, `title`, `url`, `description`, `meta`, `score.label`, `cta.text`/`cta.url`) is HTML-escaped before interpolation — verified point-by-point by both review agents. `content.bodyHtml` itself is inserted unescaped by design (it's meant to already be rendered HTML, e.g. `renderArticleCards`'s output). That's correct today, but `escapeHtml` is a private, unexported function, and `EmailContent.bodyHtml`'s doc comment doesn't say "this is raw/trusted HTML — escape any user-derived text yourself before building it." A future caller (S-04/S-07) assembling `bodyHtml` by hand from RSS/LLM-derived strings without routing through `renderArticleCards` has no sanctioned escaping utility to reach for.
- **Fix**: Export `escapeHtml` from `layout.ts` and add a one-line doc comment on `EmailContent.bodyHtml` stating it's raw/trusted HTML the caller is responsible for escaping.
- **Decision**: FIXED — `escapeHtml` exported with a usage doc comment; `EmailContent.bodyHtml` documented as raw/trusted HTML.

### F2 — No URL-scheme allowlist before inserting `url`/`cta.url` into `href`

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/email/layout.ts:78, 104, 119 (`ctaBlockHtml`, `articleCardHtml`)
- **Detail**: `escapeHtml` neutralizes attribute-breakout (a `"` in a URL can't escape the `href="..."` attribute) but doesn't restrict the URL *scheme* — a `javascript:` URI would render as an escaped-but-clickable link. Not exploitable today (no real caller wires external URLs in yet, and most mail clients block script execution from links regardless), but worth a defense-in-depth check once RSS-derived article URLs are actually wired through in S-04.
- **Fix**: When a real caller wires article URLs in, validate/restrict to `http(s)` schemes before rendering (or when convenient, add it to `layout.ts` now as a cheap belt-and-suspenders check).
- **Decision**: FIXED — added `isSafeUrl()` (http/https only); `cta` block is omitted and article titles/"Read article" links fall back to unlinked text for any non-http(s) scheme. 2 new tests cover both paths.

### F3 — `from` address set via transport `defaults`, not inline in `sendMail()` as the plan's code sketch showed

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/email/client.ts:38-41 (vs. plan.md Phase 2 §4's `sendMail({ from: ..., to, ... })` sketch)
- **Detail**: The plan's `send.ts` contract text showed `from` passed inline at send time. The actual implementation sets it once via nodemailer's `createTransport(options, { from: config.user })` second-argument `defaults`, which nodemailer merges into every send made through that transport. Verified this is real, documented nodemailer behavior — every sent email does get a correct `From:` address. Functionally equivalent, just relocated from call-site to construction-time; no behavior gap.
- **Fix**: None needed — this is a better location for the setting (one place instead of repeated at every call site). Purely a note for anyone reading the plan against the code later.
- **Decision**: SKIPPED

### F4 — Plan's Phase 3 item #3 literally specifies `status: planned`, a stale draft-era leftover

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: plan.md:201 (vs. actual context/changes/outbound-email-notifications/change.md:4)
- **Detail**: The plan's own Phase 3 "Change record" Contract text says `status: planned`, written when the plan was first drafted before any phase existed. The `/10x-implement` skill's own bookkeeping correctly overrides this and sets `status: implemented` once all phases complete — which is what actually happened (`change.md` is internally consistent: `status: implemented`, all 14 Progress rows checked off with commit SHAs). This is a plan-authoring artifact, not an implementation bug — no code or process actually followed the stale instruction.
- **Fix**: None needed for this change; if the plan template's "Change record" phase item is reused as a pattern for future plans, consider phrasing it as "set to the terminal status per /10x-implement's bookkeeping" rather than naming a literal status value that goes stale.
- **Decision**: SKIPPED

## Additional notes (no action needed)

- Both review agents independently ran the unit suite (`npx vitest run src/lib/email --reporter=verbose`): 28 passed, 1 skipped (live smoke, correctly self-skipping without `EMAIL_LIVE_SMOKE=1`).
- `sendEmail()`'s "never throws" contract was traced through every path, including the non-obvious one where `renderEmailHtml`/`renderEmailText` execute inside the `try` block as part of `sendMail()`'s argument list — a render-time throw is still caught.
- Two-runtime boundary confirmed airtight: no file under `src/pages/`, `src/components/`, `src/layouts/`, or `src/middleware.ts` imports `@/lib/email`; no file under `src/lib/email/` imports `astro:env/server` or `@/lib/supabase*`.
- Scope discipline confirmed clean against all six "What We're NOT Doing" items — no call sites wired, no audit-trail migration, no retry logic, no multi-channel abstraction, no CLI script, one template only.
- Pattern compliance against `src/lib/llm/{client,invoke,testing}.ts` is close and deliberate — naming, null-on-missing-config, cache-per-credential, never-throws idiom, and test structure all mirror the sibling harness.
