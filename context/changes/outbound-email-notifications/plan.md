# Outbound Email Notifications (F-04) Implementation Plan

## Overview

Build a minimal, reusable capability for the system to email the operator, mirroring the F-03 LLM harness pattern: a client constructor that returns `null` on missing config, and a `send` function that never throws and returns a typed result the caller branches on. This slice delivers the harness, a Gmail SMTP transport, and one reusable branded HTML layout — it does **not** wire any real notification call site into the pipeline. FR-010's "digest ready" email, FR-019's "content ready for approval" email, and FR-021's Monday reminder are explicitly scoped to later slices (S-04, S-07) per the roadmap; this slice only builds the thing they'll call.

## Current State Analysis

No email-sending capability exists anywhere in the codebase. `src/worker/env.ts` validates only Supabase and Anthropic credentials. `src/lib/llm/` is the closest and only precedent for a worker-side, budget-agnostic external-service harness: `client.ts` builds a transport and returns `null` for missing credentials (`createLlmClient`), `invoke.ts` never throws and returns an `LlmResult<T>` the caller branches on, `testing.ts` provides a queue-based fake transport for deterministic unit tests, and `invoke.live.test.ts` is an opt-in real-call smoke test gated by an env flag. The two-runtime boundary (`eslint.config.js`) currently restricts app code from importing `@/lib/collection/*`, `@/lib/llm/*`, or `@/worker/*`, and restricts worker-side code (`src/worker/**`, `src/lib/collection/**`, `src/lib/llm/**`, `scripts/**`) from importing `astro:env/server`.

## Desired End State

A worker-safe `src/lib/email/` module exposes `createEmailClient()` and `sendEmail()`. Given valid Gmail credentials and a recipient, `sendEmail()` sends a real email through Gmail SMTP using a single reusable branded HTML layout (with an auto-derived plain-text fallback) and returns `{ ok: true }`; given missing config, an invalid recipient, or a transport failure, it returns a typed failure the caller can branch on, without throwing. The capability is fully unit-tested against a fake transport and verified once against real Gmail via an opt-in live smoke test. No pipeline stage calls it yet.

### Key Discoveries:

- `src/lib/llm/client.ts:33-45` — the `createLlmClient` shape (`(config) => Transport | null`, cached, no environment reads of its own) is the exact contract to mirror for `createEmailClient`.
- `src/lib/llm/invoke.ts:85-92` and `src/types.ts:57-72` — the `err(reason, message)` helper plus the `{ok:true,data} | {ok:false,reason,message}` result idiom (`LlmResult<T>`) is the established shared-type pattern; `EmailResult` should live alongside `LlmResult` in `src/types.ts`.
- `src/lib/llm/testing.ts:75-93` — `fakeLlmTransport(outcomes)` (a queue of responses/errors, throws if called more times than staged) is the mock pattern `fakeEmailTransport` should follow.
- `src/lib/llm/invoke.live.test.ts:18-24,44` — `describe.skipIf(!live)` gated by an env flag plus required credentials is the live-smoke pattern for `send.live.test.ts`.
- `vitest.config.ts:27` — `env: loadEnv("test", process.cwd(), ["SUPABASE_", "COLLECTION_"])` only injects `.env` values whose name starts with a whitelisted prefix into `process.env` for tests run via `npx vitest`. New env vars need their prefix added here or the live smoke test won't see them (this bit is easy to miss — the existing `ANTHROPIC_*` vars aren't in this list either, and the live LLM smoke command works around it by relying on the credential already being present in the calling shell).
- `eslint.config.js:76-120` — two restriction blocks: app-side `no-restricted-imports` (line ~81) and worker-side `astro:env/server` restriction scoped by a `files` array (line ~94). Both need `src/lib/email/` added.

## What We're NOT Doing

- Wiring any real call site (Sunday "ready for selection", "ready for approval", Monday reminder) into `collect.ts`, `rank.ts`, or any future worker script — that's S-04 and S-07.
- Persisting a notification audit trail (no DB migration, no `notified_at` columns) — deferred to whichever slice first needs it against its own domain table.
- Internal retry/backoff on transient send failures — one attempt, fail fast, typed result.
- A general multi-channel "notify" abstraction (e.g. Telegram/push) — PRD Open Question #6 is explicitly unresolved; this slice is Gmail email only.
- A CLI script (`npm run notify:test`) for manual verification — the opt-in live smoke test is the manual verification path per the operator's choice.
- Multiple templates per notification type — one reusable branded shell; callers supply heading/body/CTA content.

## Implementation Approach

Mirror `src/lib/llm/` file-for-file: `client.ts` (transport construction), `send.ts` (the never-throws harness function, analogous to `invoke.ts` but without ceiling/accounting since email has no per-call cost to bound), `testing.ts` (fake transport), plus a new `layout.ts` owning the one reusable HTML shell. `nodemailer` with Gmail's SMTP submission port (587, STARTTLS) is the transport — this is the same port normal mail clients use and isn't the port residential ISPs typically block (that's port 25, direct-to-MX), so it works from the eventual self-hosted Pi target. Auth is a Gmail App Password (requires 2-Step Verification on the sending account — Google rejects the regular account password for SMTP). All new config is optional in `src/worker/env.ts` so `npm run collect`/`npm run rank` keep working unchanged; `createEmailClient` returns `null` when any piece is missing, exactly like `createLlmClient`.

## Critical Implementation Details

- **Gmail strips `<style>` blocks in some rendering contexts** (notably the Android Gmail app and clipped-message view) — `layout.ts` must inline every style as a `style="..."` attribute on each element, and use nested `<table>` elements for structure rather than CSS flexbox/grid. This is the one genuinely non-obvious constraint the "nicely designed, renders well in Gmail" requirement depends on.
- **`vitest.config.ts`'s `loadEnv` prefix whitelist** (`["SUPABASE_", "COLLECTION_"]`) must gain `"GMAIL_"` and `"OPERATOR_"` or the new env vars set in `.env` will be invisible to `npx vitest run src/lib/email/send.live.test.ts` even though they're visible to `npm run collect` (which uses `tsx --env-file=.env` instead).
- **Gmail App Password, not the account password.** `GMAIL_APP_PASSWORD` in `.env.example` must say so explicitly — the operator needs 2-Step Verification enabled on the sending Gmail account to generate one, and a plain password will fail SMTP auth with a message that doesn't obviously point at this.

## Phase 1: Config, dependency & two-runtime wiring

### Overview

Add the `nodemailer` dependency and the optional Gmail/recipient env vars, and extend the two-runtime boundary and test env-loading to cover the new `src/lib/email/` module before any code lives there.

### Changes Required:

#### 1. Dependency

**File**: `package.json`

**Intent**: Add `nodemailer` as a runtime dependency for Gmail SMTP sending.

**Contract**: Add `nodemailer` to `dependencies`. Add `@types/nodemailer` to `devDependencies` only if the installed `nodemailer` version does not ship its own type declarations.

#### 2. Worker environment schema

**File**: `src/worker/env.ts`

**Intent**: Let the worker read Gmail credentials and the operator's recipient address, without making them required — nothing calls the email harness yet, so existing worker entrypoints must keep running unchanged when these are unset.

**Contract**: Add three `.optional()` fields to `workerEnvSchema`: `GMAIL_USER` (validated as an email), `GMAIL_APP_PASSWORD` (non-empty string), `OPERATOR_EMAIL` (validated as an email, the fixed single-operator recipient — consistent with the product's no-user-management stance, no DB/settings UI). Follow the existing `LLM_COST_CEILING_USD` comment style: a one-line comment above the block naming this as F-04's config.

#### 3. Env documentation

**File**: `.env.example`

**Intent**: Document the new optional vars so the operator knows how to provision them.

**Contract**: Add a commented block (mirroring the existing F-02/F-03 blocks) for `GMAIL_USER`, `GMAIL_APP_PASSWORD` (note: must be a Gmail **App Password** — requires 2-Step Verification on the account, the regular account password will not work), `OPERATOR_EMAIL`, and `EMAIL_LIVE_SMOKE` (opt-in flag, leave unset by default, mirroring `LLM_LIVE_SMOKE`/`COLLECTION_LIVE_SMOKE`).

#### 4. Two-runtime boundary

**File**: `eslint.config.js`

**Intent**: Keep `src/lib/email/` out of the Astro/workerd bundle (app code must not import it) and keep it from importing `astro:env/server` (it must resolve in plain Node).

**Contract**: Add `"@/lib/email/*"` and `"@/lib/email"` to the `group` array in the app-side `no-restricted-imports` block (~line 81), alongside the existing `@/lib/llm/*` entries. Add `"src/lib/email/**"` to the `files` array of the worker-side restriction block (~line 94), alongside `src/worker/**`, `src/lib/collection/**`, `src/lib/llm/**`.

#### 5. Test env loading

**File**: `vitest.config.ts`

**Intent**: Let the new env vars reach `process.env` when tests run via `npx vitest` (not just via `tsx --env-file=.env`).

**Contract**: Add `"GMAIL_"` and `"OPERATOR_"` to the prefix array passed to `loadEnv("test", process.cwd(), [...])` (~line 27).

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Build passes (type-checks the updated env schema): `npm run build`
- Existing suite still passes unchanged: `npm test`

---

## Phase 2: Email client, branded layout & send harness

### Overview

Build the actual `src/lib/email/` module: transport construction, the one reusable HTML email shell, the never-throws send function, shared result types, and a fake-transport test double — all unit-tested without touching real Gmail.

### Changes Required:

#### 1. Shared result types

**File**: `src/types.ts`

**Intent**: Give the email harness the same typed-result idiom as the LLM harness, so callers branch on `ok` the same way everywhere in the codebase.

**Contract**: Add `EmailErrorReason` (`"not_configured" | "invalid_recipient" | "send_failed"`), `EmailError` (`{ ok: false; reason: EmailErrorReason; message: string }`), and `EmailResult` (`{ ok: true } | EmailError`) — placed near `LlmErrorReason`/`LlmError`/`LlmResult`, with a doc comment in the same style explaining each reason.

#### 2. Email client

**File**: `src/lib/email/client.ts`

**Intent**: Construct (or reuse) a Gmail SMTP transport, returning `null` when credentials are absent so callers get `not_configured` instead of a confusing SDK auth error.

**Contract**: Export an `EmailTransport` interface narrowed to `nodemailer`'s `sendMail` method (mirror `LlmTransport`'s `Pick<Anthropic["messages"], "create">` pattern: `Pick<nodemailer.Transporter, "sendMail">`). Export `createEmailClient(config: { user: string; appPassword: string } | null): EmailTransport | null` — returns `null` if `config` is `null`; otherwise builds a cached `nodemailer.createTransport({ service: "gmail", auth: { user, pass: appPassword } })`, cached per `user` like `createLlmClient` caches per API key.

#### 3. Branded HTML layout

**File**: `src/lib/email/layout.ts`

**Intent**: One reusable, Gmail-safe branded shell (gradient header/body/optional CTA button/footer) that every future notification renders through, so design work happens once here rather than being redone per notification type. The palette and structure (gradient header banner, rounded card + shadow, bordered content box, gradient CTA button) deliberately mirror the client's other app ("Real Estate AI Agent") so notifications from both products share a visual identity, decided mid-implementation once the operator shared that app's existing template as a reference.

**Contract**: Export `EmailContent { heading: string; bodyHtml: string; bodyText?: string; cta?: { text: string; url: string } }`. Export `renderEmailHtml(content: EmailContent): string` — a single centered `<table>` (~600px), system font stack, every rule as an inline `style` attribute (see Critical Implementation Details — no `<style>` block), with the CTA rendered as a table-based bulletproof button only when `content.cta` is present. Export `renderEmailText(content: EmailContent): string` — returns `content.bodyText` if supplied, else a plain-text fallback derived from `heading` + `bodyHtml` with tags stripped. Export `ArticleScoreTier = "high" | "medium" | "low"` and `ArticleScore { tier: ArticleScoreTier; label: string }` — a generic 3-level relevance indicator deliberately not named after the ranking module's `GeographyTier`, so a future caller (S-04) maps its real tier onto this scale and supplies its own display text. Export `ArticleCard { title: string; url?: string; description?: string; meta?: string; score?: ArticleScore }` and `renderArticleCards(articles: ArticleCard[]): string` — a per-article bordered card fragment (auto-numbered badge by list position, title linked when `url` is given, optional description snippet, optional score pill + tier-colored left border reusing the client's other app's green/amber palette plus a neutral slate for "low", optional meta as a colored pill, and a "Read article →" link shown when `url` is given) that a caller embeds into `EmailContent.bodyHtml`; deliberately generic (not coupled to the digest/article schema) so mapping real article/score data to it is a future slice's job (S-04).

#### 4. Send harness

**File**: `src/lib/email/send.ts`

**Intent**: The single entry point for sending a notification — validates the recipient, calls the transport, and reports the outcome in the `EmailResult` idiom without ever throwing, matching `invoke()`'s contract that an unattended run must not die on an uncaught error.

**Contract**: Export `EmailRequest { subject: string; content: EmailContent }`. Export `async function sendEmail(transport: EmailTransport | null, to: string | undefined, request: EmailRequest): Promise<EmailResult>`. Order: if `transport` is `null` or `to` is empty/undefined, return `not_configured`; if `to` fails a basic email-shape check, return `invalid_recipient` (fail before touching the network); call `transport.sendMail({ from: ..., to, subject: request.subject, html: renderEmailHtml(request.content), text: renderEmailText(request.content) })` in a try/catch, returning `send_failed` with the caught error's message on rejection, `{ ok: true }` on success. No retry — one attempt (per the fail-fast decision).

#### 5. Test double

**File**: `src/lib/email/testing.ts`

**Intent**: A deterministic fake transport for unit tests, so the harness's branches are testable without spending an email send or touching the network.

**Contract**: Export `fakeEmailTransport(outcomes: (true | Error)[])` returning a `FakeEmailTransport extends EmailTransport` with a `calls: unknown[]` array recording every `sendMail` invocation, resolving/rejecting from a queue in order, throwing if called more times than staged — mirror `fakeLlmTransport`'s shape exactly.

#### 6. Unit tests

**File**: `src/lib/email/send.test.ts`, `src/lib/email/layout.test.ts`, `src/lib/email/client.test.ts`

**Intent**: Cover every branch of the new harness against the fake transport.

**Contract**: `send.test.ts` — `not_configured` when transport is `null`; `not_configured` when `to` is undefined/empty; `invalid_recipient` for a malformed address; `send_failed` when the fake transport rejects, with the underlying message surfaced; `{ ok: true }` on success, asserting the fake transport received the rendered HTML/text/subject/to. `layout.test.ts` — `renderEmailHtml` includes the heading and body, includes the CTA block only when `cta` is passed, contains no `<style>` tag; `renderEmailText` returns a supplied `bodyText` verbatim, or a tag-stripped fallback when omitted; `renderArticleCards` renders each title, links it only when `url` is given, renders the meta/description/score-label only when given, gives each score tier a distinct accent color (and omits the accent border entirely when no score is given), and escapes title/url/description/meta/score label. `client.test.ts` — `createEmailClient(null)` returns `null`; a config object returns a non-null transport exposing `sendMail`.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- Render `renderEmailHtml()`'s output to a local `.html` file and open it in a browser to eyeball the layout (heading, body spacing, CTA button, footer) before Phase 3 spends a real send on it

---

## Phase 3: Live smoke test & docs

### Overview

Prove the harness works against real Gmail once, and document the new capability the way F-03's LLM harness is documented in `CLAUDE.md`.

### Changes Required:

#### 1. Live smoke test

**File**: `src/lib/email/send.live.test.ts`

**Intent**: Catch what mocks can't — a bad App Password, Gmail rejecting the connection, or nodemailer's real response shape drifting from what the harness assumes — mirroring `invoke.live.test.ts`'s role for the LLM harness.

**Contract**: `describe.skipIf(!live)`, gated by `EMAIL_LIVE_SMOKE === "1"` plus `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and `OPERATOR_EMAIL` all present (same `requireEnv` helper pattern as `invoke.live.test.ts`). One test: build a real client via `createEmailClient`, call `sendEmail` with a clearly-marked test subject/body (e.g. `[Real Estate News] F-04 live smoke test`), assert `result.ok === true`. Document the run command as a header comment: `EMAIL_LIVE_SMOKE=1 npx vitest run src/lib/email/send.live.test.ts`.

#### 2. CLAUDE.md

**File**: `CLAUDE.md`

**Intent**: Give future agents the same at-a-glance orientation for the email harness that F-03 gets for the LLM harness.

**Contract**: Add `src/lib/email/` to the "Pipeline worker" bullet's file list under "Two runtimes — do not cross the boundary". Add a new `## Outbound email goes through the harness (F-04)` section (placed after the "LLM calls go through the harness (F-03)" section) covering: build the client with `createEmailClient(config)` (returns `null` on missing config), call `sendEmail(transport, to, request)`, branch on `EmailResult`'s `ok`/`reason` (`not_configured | invalid_recipient | send_failed`), the `EMAIL_LIVE_SMOKE=1` live smoke command, and the explicit note that no pipeline stage calls this yet — it is a foundation slice consumed starting at S-04/S-07. Add the new command to the `## Commands` section's test-related bullet list, next to `LLM_LIVE_SMOKE`.

#### 3. Change record

**File**: `context/changes/outbound-email-notifications/change.md`

**Intent**: Reflect that the change has moved from planned into implementation-ready state per the skill's own bookkeeping (handled automatically by `/10x-plan`, listed here for completeness).

**Contract**: `status: planned`, `updated: <today>`.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Build passes: `npm run build`
- Default suite unaffected (`send.live.test.ts` self-skips without `EMAIL_LIVE_SMOKE=1`): `npm test`

#### Manual Verification:

- With `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and `OPERATOR_EMAIL` set in `.env`, run `EMAIL_LIVE_SMOKE=1 npx vitest run src/lib/email/send.live.test.ts` and confirm it passes
- Open the received email in Gmail (web, and mobile if convenient) and confirm the branded layout renders correctly — heading, body, CTA button, and footer all visible and styled as intended, nothing stripped or broken

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- Every `sendEmail` branch (`not_configured`, `invalid_recipient`, `send_failed`, success) against the fake transport
- `renderEmailHtml`/`renderEmailText` content and CTA-presence branching
- `createEmailClient` null-vs-configured branching

### Integration Tests:

- None — no DB or cross-module round trip is introduced by this slice (deliberately stateless, per the Audit decision).

### Manual Testing Steps:

1. Preview `renderEmailHtml()` output in a browser (Phase 2) to catch layout mistakes before spending a real send.
2. Run the live smoke test (Phase 3) and confirm the email actually lands and renders correctly in Gmail.

## Performance Considerations

None — single low-volume transactional sends, no batching or concurrency concerns (unlike the LLM harness's ceiling-under-concurrency issue, there is no per-call cost to bound here).

## Migration Notes

None — no schema changes in this slice.

## References

- Roadmap: `context/foundation/roadmap.md` (F-04: Outbound email notifications)
- PRD: `context/foundation/prd.md` (FR-010, FR-019, FR-021)
- Pattern precedent: `src/lib/llm/client.ts`, `src/lib/llm/invoke.ts`, `src/lib/llm/testing.ts`, `src/lib/llm/invoke.live.test.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Config, dependency & two-runtime wiring

#### Automated

- [x] 1.1 Lint passes: `npm run lint` — 25855e4
- [x] 1.2 Build passes: `npm run build` — 25855e4
- [x] 1.3 Existing suite still passes unchanged: `npm test` — 25855e4

### Phase 2: Email client, branded layout & send harness

#### Automated

- [x] 2.1 Unit tests pass: `npm test` — dcd551c
- [x] 2.2 Lint passes: `npm run lint` — dcd551c
- [x] 2.3 Build passes: `npm run build` — dcd551c

#### Manual

- [x] 2.4 Render `renderEmailHtml()` output to a local `.html` file and eyeball the layout in a browser — dcd551c

### Phase 3: Live smoke test & docs

#### Automated

- [x] 3.1 Lint passes: `npm run lint`
- [x] 3.2 Build passes: `npm run build`
- [x] 3.3 Default suite unaffected: `npm test`

#### Manual

- [x] 3.4 Run `EMAIL_LIVE_SMOKE=1 npx vitest run src/lib/email/send.live.test.ts` with real Gmail credentials set and confirm it passes
- [x] 3.5 Open the received email in Gmail and confirm the branded layout renders correctly
