# Operator PIN Access Gate — Plan Brief

> Full plan: `context/changes/operator-pin-access-gate/plan.md`

## What & Why

Replace the scaffolded Supabase email/password auth with a 6-digit PIN gate,
protected by lockout-after-5-fails plus rate limiting. This is F-02 on the
roadmap: the PRD (US-22, NFR "Access resistance") requires guessing the PIN
at scale to be rejected before it reaches the publishing controls, while the
single legitimate operator is never permanently locked out by ordinary
mistypes. It unlocks S-03, the roadmap's north star (the translated shortlist
dashboard view).

## Starting Point

The scaffold already has full Supabase email/password auth wired through
`src/middleware.ts`, `src/lib/supabase.ts`, and `src/pages/auth/*` — but it's
the wrong mechanism for a single-operator product with no sign-up flow.
Domain-table access (`digest`/`article`/`cluster`) already assumes this PIN
gate will exist: RLS is deny-by-default with no policies, and a service-role
client (`src/lib/supabase-admin.ts`) already exists for server-side reads —
none of that needs to change here.

## Desired End State

Visiting `/dashboard` without a valid session redirects to a PIN entry page.
Five wrong PINs in a row lock out further attempts for 15 minutes; the
correct PIN always succeeds immediately and clears the lockout. A successful
login sets a signed session cookie good for ~30 days, verified in middleware
with no database read per request. The old email/password scaffold no longer
exists in the codebase.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Scope boundary | App-level gate only; Cloudflare Tunnel/systemd excluded | Keeps the plan testable via `npm run dev` with no Pi/tunnel dependency; tunnel setup is separate ops work |
| Lockout scope & duration | Global (single-row) counter, 15-min timed cooldown, auto-recovers | Matches "not permanently locked out" in the PRD; simplest data model, one shared operator |
| PIN storage | Hashed (HMAC-SHA256 + pepper) env var, redeploy to rotate | No plaintext PIN at rest; zero new table for a value that changes rarely |
| Rate limiting | The same DB-backed attempt counter, no separate mechanism | One mechanism, fully testable in Vitest without Cloudflare-specific bindings |
| Session mechanism | Signed stateless cookie, no session table | No DB round trip per authenticated request; matches Workers' stateless model |
| Session lifetime | ~30 days | Matches the weekly usage pattern — re-entering a PIN every visit would add friction to the workflow this product exists to shrink |
| Testing depth | Unit tests + opt-in Supabase integration test | Matches this repo's established convention (`SUPABASE_TEST_PROJECT=1`); catches RLS/grant mistakes mocks can't |
| Old scaffold cleanup | Removed entirely (pages, routes, components, `@supabase/ssr` dependency) | Avoids a dormant second, weaker auth path — the roadmap explicitly calls this out as a risk |

## Scope

**In scope:** PIN entry page + verify route, DB-backed lockout/rate-limit
counter (migration + atomic RPC), signed session cookie, middleware/locals
rewrite, full removal of the old email/password scaffold, unit + opt-in
integration tests.

**Out of scope:** Cloudflare Tunnel/systemd/Pi deployment, PIN rotation via
the dashboard, per-IP attempt tracking, server-side session revocation, any
change to domain-table RLS or the existing service-role client.

## Architecture / Approach

Build new, then delete old — never run both auth paths at once. A single
global lockout row (`pin_lockout_state`) plus one atomic `security definer`
RPC (`record_pin_attempt`) checks-and-records each attempt in one round trip,
avoiding the two-round-trip race the LLM cost ceiling already got bitten by.
PIN hashing and session-cookie signing both reuse one HMAC-SHA256 pattern via
`crypto.subtle` — no new dependency, works identically in `astro dev` and on
Cloudflare Workers.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Lockout data model | Migration + atomic RPC, no app wiring yet | Getting the atomicity right (avoid the F-03 race class) |
| 2. Crypto primitives | PIN hash/verify + session sign/verify + setup script | Must work identically in Node dev and workerd |
| 3. PIN entry route | New page + verify-PIN API + rewritten sign-out | Old scaffold still live in parallel — no cutover yet |
| 4. Middleware cutover | Gate actually activates; dashboard updated | This is the point of no easy rollback — pause for manual confirmation before Phase 5 |
| 5. Scaffold removal | Delete old auth code + dependency; finish test coverage | Destructive — only run once Phase 4 is proven end-to-end |

**Prerequisites:** None (F-02 has no roadmap prerequisites).
**Estimated effort:** ~1-2 sessions across 5 phases.

## Open Risks & Assumptions

- Assumes `crypto.subtle` behaves identically enough between `astro dev` (Node) and Cloudflare Workers for HMAC sign/verify — both are standard Web Crypto, but this is worth confirming manually in Phase 2/3, not just in unit tests run under Node.
- Assumes a single global lockout row is acceptable even though it means one attacker probing from anywhere locks out the operator too — this is a deliberate PRD tradeoff (brute-force resistance over uninterrupted access), not an oversight.

## Success Criteria (Summary)

- `/dashboard` is unreachable without a valid PIN-derived session, and reachable within seconds of entering the correct PIN
- 5 wrong PINs lock out for 15 minutes; a correct PIN always works immediately regardless of lockout state
- The old email/password scaffold is fully gone with no remaining `@supabase/ssr` references
