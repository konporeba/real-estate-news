# Outbound Email Notifications (F-04) — Plan Brief

> Full plan: `context/changes/outbound-email-notifications/plan.md`

## What & Why

The roadmap's F-04 foundation: give the system a minimal, reusable way to email the operator. Three pipeline moments will eventually depend on this (digest ready for selection, content ready for approval, Monday reminder — FR-010/019/021), but this slice builds only the send capability itself, not the wiring — those call sites belong to S-04 and S-07, which don't exist yet.

## Starting Point

No email-sending code exists in the repo today. The only precedent is `src/lib/llm/` (F-03): a `client.ts` that returns `null` on missing credentials, an `invoke.ts` that never throws and returns a typed result, and an opt-in live-call smoke test. This plan mirrors that shape for email.

## Desired End State

`src/lib/email/` exports `createEmailClient()` and `sendEmail()`. Given Gmail credentials and a recipient, calling `sendEmail()` sends a real, nicely-designed HTML email (with a plain-text fallback) via Gmail SMTP and returns `{ ok: true }`; missing config, a bad recipient, or a transport failure return a typed error instead of throwing. Fully unit-tested against a fake transport; verified once for real via an opt-in live smoke test. Nothing in the pipeline calls it yet.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Provider | Gmail SMTP via `nodemailer`, App Password auth | User already has a Gmail sending address; port 587 STARTTLS isn't the port residential ISPs block, so it works from the eventual self-hosted Pi. |
| Config requirement | Optional in `src/worker/env.ts` | No call site exists yet — required env vars would break `npm run collect`/`npm run rank` today for no benefit. |
| Audit trail | None — stateless send function | Matches how F-01/F-02/F-03 stayed minimal; a speculative schema now risks mismatch once S-04/S-07 land with real requirements. |
| Retry policy | Fail fast, no internal retry | Simplest harness; email has no per-call cost/ceiling to justify LLM-style retry complexity. |
| HTML content | Build one reusable branded layout shell now | User wants nicely-designed emails; one shared layout means every future notification looks consistent without redoing HTML-email work per slice. |
| Manual verification | Live smoke test only, no CLI script | User's explicit choice — the opt-in real-send test doubles as the manual check. |

## Scope

**In scope:** `src/lib/email/` module (client, layout, send harness, test double), optional worker env config, two-runtime boundary + test-env-loading updates, unit tests, one opt-in live smoke test, `CLAUDE.md` documentation.

**Out of scope:** wiring the three real notification call sites (S-04/S-07); a notification audit/log table; internal retry/backoff; a second channel (Telegram/push, PRD Open Question #6 unresolved); a manual-test CLI script; per-notification-type templates.

## Architecture / Approach

`src/lib/email/` mirrors `src/lib/llm/` file-for-file: `client.ts` (transport construction, `null` on missing config), `send.ts` (the never-throws harness, no ceiling/accounting needed), `testing.ts` (fake transport), plus a new `layout.ts` owning one reusable, Gmail-safe HTML shell (inline styles only — Gmail strips `<style>` blocks in some contexts). Shared `EmailResult`/`EmailError` types join `LlmResult`/`LlmError` in `src/types.ts`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Config & wiring | Optional env vars, `nodemailer` dependency, two-runtime boundary + test-env-loading updated | `vitest.config.ts`'s `loadEnv` prefix whitelist is easy to forget — the live smoke test would silently not see `.env` values |
| 2. Client, layout & harness | `createEmailClient`, `renderEmailHtml`/`renderEmailText`, `sendEmail`, fake transport, full unit coverage | Getting the Gmail-safe HTML right (inline styles, table layout) without a real send to check it against |
| 3. Live smoke & docs | Opt-in real-Gmail test, `CLAUDE.md` section mirroring F-03's | Requires the operator to have a Gmail App Password already provisioned (2-Step Verification enabled) |

**Prerequisites:** none (parallel with F-01/F-02/F-03 per the roadmap); the operator needs a Gmail account with 2-Step Verification enabled to generate an App Password before Phase 3's manual verification.
**Estimated effort:** ~1 session across 3 phases — small foundation slice, no DB changes.

## Open Risks & Assumptions

- Assumes Gmail SMTP's low-volume sending limits (well under the ~500/day regular-account cap) are more than sufficient for a weekly digest's handful of notifications.
- Assumes the operator can generate a Gmail App Password (requires 2-Step Verification); if that's not set up yet, Phase 3's manual verification blocks until it is.
- The one shared HTML layout locks in a visual style that every future notification (S-04/S-07) inherits — acceptable since it can still be adjusted later without touching the harness contract.

## Success Criteria (Summary)

- `sendEmail()` reliably sends a real, correctly-rendered branded email via Gmail when configured, and returns a clear typed failure (never throws) when misconfigured or when the send fails.
- The harness is fully consumable by a future slice with zero changes to its contract — S-04/S-07 just need to call `createEmailClient` + `sendEmail`.
- `npm run collect`/`npm run rank` are completely unaffected by this slice's changes.
