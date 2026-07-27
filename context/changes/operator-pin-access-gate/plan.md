# Operator PIN Access Gate Implementation Plan

## Overview

Replace the scaffolded Supabase email/password auth with a 6-digit PIN gate: a
DB-backed atomic attempt counter enforcing lockout-after-5-fails plus rate
limiting, an HMAC-signed stateless session cookie (no session table), and
removal of the email/password scaffold entirely. This is the single-operator
access control the PRD requires (US-22, NFR "Access resistance") and unlocks
S-03 (translated-shortlist-view), the roadmap's north star.

## Current State Analysis

- **Auth today** is Supabase email/password via `@supabase/ssr`: `src/middleware.ts:4-21` gates `PROTECTED_ROUTES = ["/dashboard"]` by calling `supabase.auth.getUser()` and setting `context.locals.user`; `src/lib/supabase.ts:7-26` builds the SSR client from `SUPABASE_URL`/`SUPABASE_KEY` (`astro.config.mjs:17-27`) with no explicit cookie-flag overrides; `src/pages/auth/{signin,signup,confirm-email}.astro` and `src/pages/api/auth/{signin,signup,signout}.ts` implement the flow; `src/components/auth/{FormField,PasswordToggle,ServerError,SignInForm,SignUpForm,SubmitButton}.tsx` are the form components; `src/pages/dashboard.astro:4,14` reads `Astro.locals.user.email` for display. `@supabase/ssr` is used nowhere else in `src/`.
- **No rate-limiting/lockout/attempt-tracking code exists anywhere in the repo** — this is new ground, confirmed by a full-repo grep.
- **Domain-table access is already designed for this gate.** `supabase/migrations/20260722173032_digest_core_schema.sql:151-161` enables deny-by-default RLS on `digest`/`article`/`cluster` with no policies at all, and its own comment states the private-path + PIN gate *is* the access control — server code reaches these tables only via the service-role client. `src/lib/supabase-admin.ts` / `src/lib/supabase-service.ts` (`createServiceClient()`) already exist for this. **The PIN gate does not need to touch RLS or domain-table access at all** — that path was already built assuming no Supabase-Auth user would exist.
- **Atomic-counter precedent exists** in `supabase/migrations/20260724170000_digest_cost_increment.sql` (`increment_digest_cost`) and `20260727150000_bulk_ranking_writes.sql`: a `security definer` SQL function doing a single `update ... returning`, with `revoke all` then `grant execute ... to service_role` only. This is the pattern the new lockout RPC follows.
- **A hard-won lesson applies directly**: the roadmap's F-03 "Done" note records that splitting a check and an increment into two round trips made the LLM cost ceiling soft under concurrency. The lockout RPC must do its check-and-record in a **single atomic statement**, not a separate "is it locked" query followed by an "record this attempt" query.
- **Runtime constraint**: `wrangler.jsonc:6` sets `nodejs_compat`, but `astro dev` runs on Vite/Node, not workerd — so any crypto primitive must work identically in both without adapter branching. `globalThis.crypto.subtle` (Web Crypto) is natively available in both and needs no new dependency; `package.json` has no bcrypt/argon2/jose today, and none is needed.
- **`src/env.d.ts:1-5`** is the only `App.Locals` declaration (`{ user: User | null }`) and must be replaced — there is no Supabase-Auth user anymore, only an authenticated/not-authenticated boolean.
- **No existing tests** cover auth or middleware (`src/**/*.test.ts` has none for these paths) — this is greenfield for test coverage too.

## Desired End State

The dashboard (and every future dashboard route) is reachable only after the
operator submits the correct 6-digit PIN. Five wrong PINs in a row lock out
further attempts for 15 minutes; a correct PIN always succeeds immediately
(including during an active lockout, since it already proves knowledge of the
secret) and clears the counter. A successful PIN sets a signed session cookie
valid ~30 days, verified on every request by `src/middleware.ts` with no
database read. The old email/password scaffold — pages, API routes, form
components, and the anon-key SSR client — no longer exists in the codebase.

**Verification:** `npm run dev`, visit `/dashboard`, get redirected to
`/auth/pin`; 5 wrong PINs lock out with a clear message; the correct PIN
(hashed via the new setup script) logs in and redirects to `/dashboard`;
the session cookie survives a server restart within its 30-day window;
`npm test` and `npm run lint` pass; `RANKING_EVAL`/other unrelated suites
are unaffected.

### Key Discoveries

- `supabase/migrations/20260722173032_digest_core_schema.sql:151-161` — RLS on domain tables already assumes no Supabase-Auth identity; nothing there changes in this plan.
- `src/lib/supabase-admin.ts` — service-role client already exists for any future dashboard data reads; not part of this change's scope, noted only so the next slice (S-03) doesn't need to build it.
- `supabase/migrations/20260724170000_digest_cost_increment.sql` — the exact RPC shape (`security definer`, `revoke all` + `grant to service_role`) to replicate for the lockout counter.
- `globalThis.crypto.subtle` works in both `astro dev` (Node ≥19) and Cloudflare Workers — the only primitive needed for PIN hashing and cookie signing; no new dependency.

## What We're NOT Doing

- **Cloudflare Tunnel / systemd / Raspberry Pi setup.** The "private path" network exposure is separate ops work; this plan only builds the code that gates access regardless of network path.
- **PIN rotation via the dashboard.** The PIN hash is a redeploy-to-rotate secret (`PIN_HASH` + `PIN_PEPPER` env vars), not a DB-stored, self-service-editable value.
- **Per-IP attempt tracking.** The lockout counter is a single global row — there is exactly one legitimate operator, and a proxy/tunnel in front of the app can obscure real client IPs anyway.
- **A DB-backed session table or server-side session revocation.** Sessions are stateless signed cookies; there is no "sign out everywhere" concept for a single operator on presumably one device.
- **Any change to domain-table RLS or `supabase-admin.ts`/`supabase-service.ts`.** Those already assume the PIN-gate world and are untouched.
- **A general identity system, roles, or multi-tenancy.** One operator, one PIN, forever.

## Implementation Approach

Build the new mechanism first, prove it end-to-end, then delete the old one —
never run both at once. Five phases: (1) the DB-backed lockout/rate-limit
counter as an isolated, independently-testable migration + RPC; (2) the
crypto primitives (PIN hashing, session signing) as pure functions with no
route wiring yet; (3) the new routes/pages that compose (1) and (2); (4) the
middleware/locals rewrite that actually flips the gate on; (5) deletion of
the old scaffold plus the full test suite. This order means the app has a
working (if not yet wired) PIN mechanism before the old auth path is ever
touched, and the destructive step (deleting the scaffold) happens last, once
everything it would be replacing already works.

## Critical Implementation Details

**Atomicity of the lockout RPC.** Do the "is this currently locked" check and
the "record this attempt" write in one SQL statement (one `UPDATE ...
RETURNING`), not two round trips — this is the exact race class the F-03 cost
ceiling already got bitten by. A correct PIN should always authenticate and
clear the lockout immediately, even mid-cooldown: the cooldown's job is to
slow down *guessing*, and a correct submission already proves the secret was
known, so blocking it adds friction for the operator without adding
brute-force resistance. A wrong guess that arrives while already locked
should not extend the lockout further (the cooldown window is fixed from
first trigger, not perpetually renewed by continued probing).

**One HMAC-verify helper, two callers.** Use `crypto.subtle.sign`/`verify`
with HMAC-SHA256 for both PIN checking and session-cookie verification —
`crypto.subtle.verify` does the byte comparison internally in constant time,
so there's no need to hand-roll a timing-safe compare for either case. PIN
storage is `PIN_HASH = HMAC-SHA256(key: PIN_PEPPER, message: PIN)`, generated
once by a small setup script and pasted into secrets; there is no in-app PIN
hashing flow since there is no sign-up.

## Phase 1: Lockout & rate-limit data model

### Overview

An isolated, single-row table plus one atomic RPC that a future caller (Phase
3) will use to check-and-record every PIN attempt in one round trip. No app
code changes yet — this phase is fully verifiable via `npm run rank`-style
direct migration/RPC testing.

### Changes Required

#### 1. Migration: lockout state table + RPC

**File**: `supabase/migrations/<YYYYMMDDHHMMSS>_pin_lockout_state.sql`

**Intent**: A singleton table tracking failed-attempt count and an optional
lockout expiry, seeded with its one row at migration time so the RPC can
always `UPDATE` without upsert logic. One `security definer` RPC does the
entire check-and-record step atomically, following the
`increment_digest_cost` precedent (`revoke all` then `grant execute` to
`service_role` only; deny-by-default RLS on the table itself, matching the
domain tables).

**Contract**: `record_pin_attempt(p_matched boolean, p_max_attempts int, p_lockout_seconds int) returns table(authenticated boolean, locked_until timestamptz)`, called with `security definer` and `search_path = public`, restricted to `service_role`. Semantics in one `UPDATE ... RETURNING`:
- If `p_matched` is true → `authenticated = true`, `failed_attempts` resets to 0, `locked_until` clears to `null`, regardless of prior lockout state.
- Else if currently locked (`locked_until is not null and locked_until > now()`) → `failed_attempts` and `locked_until` are left unchanged (no extension from continued probing during an active lockout); `authenticated = false`.
- Else → `failed_attempts` increments by 1; if the new count reaches `p_max_attempts`, `locked_until` is set to `now() + make_interval(secs => p_lockout_seconds)`; `authenticated = false`.

#### 2. Migration test (opt-in integration)

**File**: `supabase/migrations/<YYYYMMDDHHMMSS>_pin_lockout_state.sql` (same migration — no separate file)

**Intent**: No app-level test file yet in this phase; the RPC's behavior is exercised by the Phase 5 integration test once the app-level caller exists, to avoid duplicating the same assertions in two places.

**Contract**: N/A (deferred to Phase 5).

### Success Criteria

#### Automated Verification

- Migration applies cleanly against the local/test Supabase project: `npx supabase db push` (or the project's existing migration-apply command)
- `npm run lint` passes (no app code touched yet, but the migration file itself should pass any SQL lint step this repo runs, if any)

#### Manual Verification

- Inspect the seeded row exists (`select * from pin_lockout_state`) after migration apply
- Manually call the RPC via the Supabase SQL editor with `p_matched := false` five times, confirming `locked_until` is set on the 5th call and not before
- Manually call the RPC with `p_matched := true` while `locked_until` is in the future, confirming it still authenticates and clears the lockout

---

## Phase 2: PIN & session crypto primitives

### Overview

Pure-function crypto helpers with no route wiring: hashing/verifying the PIN
against `PIN_HASH`/`PIN_PEPPER`, and signing/verifying the session cookie
payload. Also adds the three new secrets to the env schema and a one-off
setup script to generate `PIN_HASH` before first deploy.

### Changes Required

#### 1. Env schema additions

**File**: `astro.config.mjs`

**Intent**: Add `PIN_HASH`, `PIN_PEPPER`, `SESSION_SECRET` alongside the existing `SUPABASE_*` entries so they're available via `astro:env/server`.

**Contract**: Three new `env.schema` entries, each `context: "server", access: "secret", optional: true` — same shape as the existing `SUPABASE_URL` entry at `astro.config.mjs:17-27`.

#### 2. Local dev secrets

**File**: `.dev.vars`, `.env.example`

**Intent**: Document the three new vars for local Cloudflare dev and as example documentation, following the existing per-var comment convention in `.env.example`.

**Contract**: Add `PIN_HASH`, `PIN_PEPPER`, `SESSION_SECRET` entries; `.env.example`'s comment for each should note `PIN_HASH` is generated by the Phase 2 setup script, not typed by hand.

#### 3. PIN hashing/verification helper

**File**: `src/lib/auth/pin.ts`

**Intent**: Compute and verify the HMAC-SHA256 PIN hash used both by the setup script and the verify-PIN route.

**Contract**: `hashPin(pin: string, pepper: string): Promise<string>` returns a base64url-encoded HMAC-SHA256 digest via `crypto.subtle.importKey`/`sign`. `verifyPin(pin: string, pepper: string, storedHashBase64url: string): Promise<boolean>` recomputes and compares via `crypto.subtle.verify` (not a manual byte comparison) so the check is constant-time by construction.

#### 4. Session cookie signing/verification helper

**File**: `src/lib/auth/session.ts`

**Intent**: Issue and verify the stateless session cookie value.

**Contract**: `createSessionToken(secret: string, maxAgeSeconds: number): Promise<string>` returns `<base64url(JSON payload {exp})>.<base64url(HMAC-SHA256 signature over that segment)>`. `verifySessionToken(token: string, secret: string): Promise<boolean>` splits on `.`, recomputes the signature via `crypto.subtle.verify`, and additionally checks `payload.exp > Date.now() / 1000`.

#### 5. PIN hash setup script

**File**: `scripts/hash-pin.mjs`

**Intent**: A one-off Node script the operator runs once (and again on rotation) to generate `PIN_HASH` from a chosen PIN and `PIN_PEPPER`, for pasting into `.dev.vars`/Cloudflare secrets — there is no in-app way to set the initial PIN since there is no sign-up flow.

**Contract**: Invoked as `node scripts/hash-pin.mjs <pin> <pepper>`, prints the resulting `PIN_HASH` value to stdout. Reuses `hashPin` from `src/lib/auth/pin.ts` (Node ≥19's global `crypto.subtle` makes this importable directly, no separate implementation).

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm test` — round-trip tests for `hashPin`/`verifyPin` (correct PIN verifies, wrong PIN doesn't, wrong pepper doesn't) and `createSessionToken`/`verifySessionToken` (valid token verifies, tampered payload fails, expired `exp` fails)
- Type checking passes: `npm run lint`

#### Manual Verification

- Run `node scripts/hash-pin.mjs 123456 <some-pepper>` and confirm it prints a stable, deterministic hash for the same inputs

---

## Phase 3: PIN entry route and API

### Overview

Wires Phase 1 (lockout RPC) and Phase 2 (crypto helpers) into a new PIN entry
page and its POST handler, plus a rewritten sign-out route. The old
`/auth/signin` scaffold still exists and still works at this point — nothing
is deleted yet.

### Changes Required

#### 1. PIN entry page

**File**: `src/pages/auth/pin.astro`

**Intent**: Replace the concept of `/auth/signin` with a PIN-only entry form — a plain Astro page with a native HTML form (numeric input, 6-digit pattern), no React needed given there's no client-side interactivity beyond basic input constraints. Displays an error or lockout message from a query param.

**Contract**: Renders a `<form method="post" action="/api/auth/verify-pin">` with a single 6-digit numeric input; reads `Astro.url.searchParams` for `error` (`invalid` | `locked`) and, when locked, a `until` timestamp to show a human-readable retry time.

#### 2. Verify-PIN API route

**File**: `src/pages/api/auth/verify-pin.ts`

**Intent**: Validate the submitted PIN's shape, check it against `PIN_HASH`/`PIN_PEPPER`, call the Phase 1 RPC via the service-role client to atomically check-and-record the attempt, and on success set the signed session cookie and redirect to `/dashboard`; on failure redirect back to `/auth/pin` with the appropriate error/lockout query params.

**Contract**: `POST`, `export const prerender = false`. Validates the form's `pin` field with zod (`z.string().regex(/^\d{6}$/)`) before any crypto/DB work. Uses `createServiceClient()` (already exists) to call the Phase 1 RPC with the app's fixed constants (`p_max_attempts: 5`, `p_lockout_seconds: 900`). Sets the cookie via `context.cookies.set(name, token, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: <30 days in seconds> })`.

#### 3. Sign-out route (rewritten, not deleted)

**File**: `src/pages/api/auth/signout.ts`

**Intent**: Replace the Supabase `auth.signOut()` call with simply clearing the session cookie — there is no server-side session state to invalidate.

**Contract**: `POST`, clears the session cookie via `context.cookies.delete(name, { path: "/" })`, redirects to `/auth/pin`.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm test` — zod validation rejects non-6-digit input before any DB call
- `npm run lint` passes

#### Manual Verification

- `npm run dev`, visit `/auth/pin` directly, submit a wrong PIN 5 times, confirm the 5th response shows a lockout message with a retry time
- Submit the correct PIN mid-lockout and confirm it authenticates immediately and redirects to `/dashboard` (even though `/dashboard` gating itself doesn't flip until Phase 4 — this phase can be manually verified by checking the cookie is set in dev tools)

---

## Phase 4: Middleware, locals, and dashboard cutover

### Overview

This is the phase where the gate actually activates: middleware stops
checking Supabase Auth and starts verifying the session cookie, and
`/dashboard` reflects the new locals shape. After this phase, the old
`/auth/signin` scaffold is dead code (still present, but unreachable in
practice since nothing links to it) — Phase 5 removes it.

### Changes Required

#### 1. Locals typing

**File**: `src/env.d.ts`

**Intent**: Replace the Supabase-`User`-shaped locals field with a simple authenticated flag — there is no per-user identity to carry anymore.

**Contract**: `interface Locals { operatorAuthenticated: boolean }`, replacing the existing `user: User | null` field.

#### 2. Middleware rewrite

**File**: `src/middleware.ts`

**Intent**: Replace the Supabase `auth.getUser()` check with `verifySessionToken` against the request's session cookie; redirect target for `PROTECTED_ROUTES` changes from `/auth/signin` to `/auth/pin`.

**Contract**: Reads the session cookie via `context.cookies.get(name)`, calls `verifySessionToken` from `src/lib/auth/session.ts`, sets `context.locals.operatorAuthenticated` accordingly. `PROTECTED_ROUTES` and the redirect-when-unauthenticated logic (`src/middleware.ts:18-21`) keep their existing shape, only the redirect target and the check itself change.

#### 3. Dashboard update

**File**: `src/pages/dashboard.astro`

**Intent**: Remove the `Astro.locals.user.email` reference (line 14) since there is no email to show for a PIN-only operator; the sign-out form stays as-is since `/api/auth/signout` still exists (Phase 3).

**Contract**: Replace the email display with a generic heading (e.g. "Operator Dashboard"); no other structural change.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm test`
- `npm run lint` passes
- `npm run build` succeeds (confirms `astro:env/server` additions and locals typing compile cleanly for the Cloudflare adapter)

#### Manual Verification

- `npm run dev`, visit `/dashboard` while logged out, confirm redirect to `/auth/pin`
- Log in with the correct PIN, confirm `/dashboard` renders and the sign-out form works, returning to `/auth/pin`
- Restart the dev server (simulating a worker restart) with the session cookie still present in the browser, confirm `/dashboard` is still reachable without re-entering the PIN (proves the session is stateless, not tied to server memory)

**Implementation Note**: Pause here for manual confirmation that the gate genuinely blocks and unblocks `/dashboard` end-to-end before proceeding to deletion in Phase 5 — Phase 5 is destructive and should only run once this phase is proven.

---

## Phase 5: Remove the old scaffold, finish test coverage

### Overview

Delete the now-fully-superseded Supabase email/password scaffold, and add the
Phase-1-deferred integration test for the lockout RPC plus any remaining unit
coverage.

### Changes Required

#### 1. Delete old auth pages and routes

**Files**: `src/pages/auth/signin.astro`, `src/pages/auth/signup.astro`, `src/pages/auth/confirm-email.astro`, `src/pages/api/auth/signin.ts`, `src/pages/api/auth/signup.ts`

**Intent**: These are fully superseded by `/auth/pin` and `/api/auth/verify-pin`; leaving them in place would be exactly the "second, weaker auth path" the roadmap's F-02 risk note warns against.

**Contract**: File deletion; no other file imports these paths (confirmed by the current grep — only `middleware.ts` and the auth API routes themselves import `src/lib/supabase.ts`, and none of them survive this phase).

#### 2. Delete old auth components

**Files**: `src/components/auth/FormField.tsx`, `src/components/auth/PasswordToggle.tsx`, `src/components/auth/ServerError.tsx`, `src/components/auth/SignInForm.tsx`, `src/components/auth/SignUpForm.tsx`, `src/components/auth/SubmitButton.tsx`

**Intent**: Dead code once the pages that rendered them are gone.

**Contract**: File deletion (whole `src/components/auth/` directory).

#### 3. Delete the anon-key Supabase SSR client and its dependency

**Files**: `src/lib/supabase.ts`, `package.json`

**Intent**: `src/lib/supabase.ts` has no remaining callers after this phase (confirmed: only the four files above imported it); `@supabase/ssr` has no remaining usage anywhere in `src/` once it's gone.

**Contract**: Delete `src/lib/supabase.ts`; remove the `@supabase/ssr` dependency from `package.json` and run the package manager's lockfile update.

#### 4. Lockout RPC integration test

**File**: `src/lib/auth/pin-lockout.test.ts`

**Intent**: Exercise the real Phase 1 RPC against the Supabase test project, following the repo's existing opt-in convention (`SUPABASE_TEST_PROJECT=1` + `SUPABASE_SERVICE_ROLE_KEY`) — this is what catches an RLS/grant mistake a mock can't, per the repo's own established testing pattern.

**Contract**: Gated behind `SUPABASE_TEST_PROJECT=1` exactly like the other integration suites; asserts the 5-fails-then-locked sequence, that a correct PIN clears an active lockout, and that a wrong guess during an active lockout doesn't extend it.

### Success Criteria

#### Automated Verification

- Full suite passes: `npm test`
- Integration suite passes when opted in: `SUPABASE_TEST_PROJECT=1 npm test` (requires `SUPABASE_SERVICE_ROLE_KEY`)
- `npm run lint` passes with no unused-import warnings for the deleted files
- `npm run build` succeeds
- `grep -r "@supabase/ssr" src/` returns no matches

#### Manual Verification

- Full manual walkthrough repeated once more end-to-end: locked out after 5 fails, correct PIN clears lockout, session persists across a restart, sign-out works, and `/auth/signin` (old route) now 404s

---

## Testing Strategy

### Unit Tests

- `src/lib/auth/pin.ts` — `hashPin`/`verifyPin` round-trip, wrong PIN, wrong pepper
- `src/lib/auth/session.ts` — valid token verifies, tampered payload fails, expired token fails
- `src/pages/api/auth/verify-pin.ts` — zod rejects malformed PIN input before any DB call

### Integration Tests

- `src/lib/auth/pin-lockout.test.ts` (opt-in, `SUPABASE_TEST_PROJECT=1`) — the full lockout state machine against the real RPC

### Manual Testing Steps

1. Fresh browser session, visit `/dashboard`, confirm redirect to `/auth/pin`
2. Submit 5 wrong PINs, confirm lockout message with a retry time on the 5th
3. Submit the correct PIN during the lockout window, confirm immediate success
4. Confirm `/dashboard` renders post-login and the session survives a dev-server restart
5. Sign out, confirm redirect to `/auth/pin` and that `/dashboard` is gated again
6. Confirm `/auth/signin`, `/auth/signup` now 404

## Performance Considerations

The lockout RPC adds one DB round trip per PIN submission (not per
authenticated request — the session cookie itself requires no DB read). At
one operator submitting a PIN at most a few times a week, this has no
measurable performance impact.

## Migration Notes

No existing data migrates — there are no Supabase Auth users to preserve
(single operator, PRD explicitly has no sign-up flow). The old
`auth.users` Supabase Auth table is left alone (Supabase-managed, not part of
this repo's migrations) but becomes unused.

## References

- Roadmap: `context/foundation/roadmap.md` (F-02, lines 89-100)
- PRD: `context/foundation/prd.md` (US-22, §Access Control lines 304-308, NFR "Access resistance")
- Atomic-counter precedent: `supabase/migrations/20260724170000_digest_cost_increment.sql`, `supabase/migrations/20260727150000_bulk_ranking_writes.sql`
- Race-condition lesson: `context/foundation/roadmap.md` F-03 "Done" note (check-and-increment as separate round trips made the cost ceiling soft)
- Existing service-role client (untouched by this plan): `src/lib/supabase-admin.ts`, `src/lib/supabase-service.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Lockout & rate-limit data model

#### Automated

- [x] 1.1 Migration applies cleanly: `npx supabase db push`
- [x] 1.2 Lint passes: `npm run lint`

#### Manual

- [x] 1.3 Seeded row exists after migration apply
- [x] 1.4 RPC locks out on the 5th failed call, not before
- [x] 1.5 RPC authenticates and clears lockout on a correct PIN mid-lockout

### Phase 2: PIN & session crypto primitives

#### Automated

- [ ] 2.1 Unit tests pass: `npm test`
- [ ] 2.2 Lint passes: `npm run lint`

#### Manual

- [ ] 2.3 `node scripts/hash-pin.mjs` prints a stable, deterministic hash

### Phase 3: PIN entry route and API

#### Automated

- [ ] 3.1 Unit tests pass: `npm test`
- [ ] 3.2 Lint passes: `npm run lint`

#### Manual

- [ ] 3.3 5 wrong PINs trigger a lockout message with a retry time
- [ ] 3.4 Correct PIN mid-lockout authenticates immediately and sets the session cookie

### Phase 4: Middleware, locals, and dashboard cutover

#### Automated

- [ ] 4.1 Unit tests pass: `npm test`
- [ ] 4.2 Lint passes: `npm run lint`
- [ ] 4.3 Build succeeds: `npm run build`

#### Manual

- [ ] 4.4 Logged-out visit to `/dashboard` redirects to `/auth/pin`
- [ ] 4.5 Logged-in `/dashboard` renders and sign-out works
- [ ] 4.6 Session survives a dev-server restart without re-entering the PIN

### Phase 5: Remove the old scaffold, finish test coverage

#### Automated

- [ ] 5.1 Full suite passes: `npm test`
- [ ] 5.2 Integration suite passes when opted in: `SUPABASE_TEST_PROJECT=1 npm test`
- [ ] 5.3 Lint passes with no unused-import warnings: `npm run lint`
- [ ] 5.4 Build succeeds: `npm run build`
- [ ] 5.5 No remaining `@supabase/ssr` references: `grep -r "@supabase/ssr" src/`

#### Manual

- [ ] 5.6 Full end-to-end walkthrough repeated post-deletion, including confirming `/auth/signin` and `/auth/signup` now 404
