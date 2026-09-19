# Ops Heartbeat & Catch-up (S-10) Implementation Plan

## Overview

S-10 closes the last unshipped roadmap slice. It has two parts, one net-new and one already
delivered: (1) FR-028's heartbeat — a dead-man's-switch ping to an external monitor
(healthchecks.io) fired after every `scheduled-run.ts` tick, so the operator learns when the home
server or scheduler has gone silent instead of mistaking silence for "no news"; and (2) FR-027's
catch-up, which F-05 already built generically for every registered job via `isJobDue` — this
plan adds a regression test that proves it against the real job registry rather than reimplementing
anything, then closes out the roadmap entry.

## Current State Analysis

- **FR-027 (catch-up) is already fully delivered by F-05.** `runScheduledJobs`
  (`src/worker/scheduled-run.ts:99-161`) calls `isJobDue(job.schedule, lastFiredAt, now)`
  generically for every entry in `SCHEDULED_JOBS` (`src/lib/scheduler/registry.ts:15-23`:
  `collection`, `approval-reminder`, `publish`), and `isJobDue` compares only against the single
  most recent scheduled instant, so any outage length collapses to exactly one catch-up fire
  (`src/lib/scheduler/schedule.ts`, documented in CLAUDE.md's scheduler section). The systemd
  timer's `Persistent=true` plus its 15-minute polling cadence (`deploy/systemd/README.md`) is
  what actually replays a missed window on next boot. `scheduled-run.test.ts` already proves the
  due-check/claim/release loop across two different weekday schedules and a stale-lock
  reclaim — but always against synthetic job names in isolation, never against the real
  `SCHEDULED_JOBS` registry as a set.
- **No heartbeat mechanism exists anywhere in the codebase** (confirmed by a repo-wide search —
  only planning docs mention it). FR-028 is fully unbuilt.
- **The codebase has one consistent harness convention for every optional external
  integration** — `src/lib/email/` (F-04), `src/lib/llm/` (F-03), the Slides/publishing clients:
  a `create<X>Client()` that returns `null` when unconfigured, a `send<X>()`/`invoke()` that never
  throws and returns a typed `{ ok: true } | { ok: false; reason; message }` result, config read
  as optional fields in `src/worker/env.ts`, and an opt-in `*_LIVE_SMOKE=1` test that exercises
  the real service once (`src/lib/email/send.live.test.ts`,
  `src/lib/visuals/slides.live.test.ts`). A heartbeat module should mirror this shape.
- **`src/lib/publishing/graph-api.ts`'s `createGraphClient(fetchImpl: typeof fetch, ...)`** is the
  closest precedent for a raw outbound HTTP call with dependency-injected `fetch` — the ping is a
  single `fetch()` call with no SDK, so this is the pattern to mirror rather than nodemailer's
  transport object. Given there is no real "client" to construct (no auth handshake, no caching —
  the ping URL itself is the only secret), this plan skips a separate `client.ts` file that other
  harnesses have; `env.HEARTBEAT_PING_URL` (`string | undefined`) is passed straight into
  `sendHeartbeat()`.
- **`main()` in `scheduled-run.ts` is never unit-tested directly** — only its exported pieces are
  (`JOB_ACTIONS`, `runScheduledJobs`). `rank.ts`'s `notifyDigestReady()` is the precedent for how
  a side-effect wrapper composed inside a worker entrypoint's `main()` gets its own direct unit
  tests instead: a `Promise<void>`-returning function that never throws, logs its own outcome, and
  is tested in isolation. The heartbeat wiring follows the same shape (`reportHeartbeat()`).
- **`vitest.config.ts`'s `loadEnv` allowlist** (`["SUPABASE_", "COLLECTION_", "GMAIL_",
  "OPERATOR_", "GOOGLE_", "SLIDES_"]`) gates which `.env` prefixes reach `process.env` under
  Vitest — a prefix left off means the live smoke test silently can't see its own credential.
  `HEARTBEAT_` needs adding here for the new live smoke test.

### Key Discoveries:

- `src/worker/scheduled-run.ts:163-169` (`main`) — the exact hook point: ping once after
  `runScheduledJobs` returns, regardless of whether any job was due, using its `boolean` result to
  choose success vs. failure signaling.
- `src/lib/email/send.ts` — the never-throw, typed-result contract to mirror exactly for
  `sendHeartbeat()`.
- `src/worker/rank.ts:220-260` (`notifyDigestReady`) — the wrapper-function-with-its-own-tests
  precedent for `reportHeartbeat()`.
- `src/worker/remind.ts:44-59` — the `not_configured` vs. real-failure logging split
  (`console.log` vs. `console.error`) to mirror.
- `src/worker/scheduled-run.test.ts` — the `TEST_JOB_PREFIX` isolation convention: tests must
  never claim/release the real `"collection"`/`"approval-reminder"`/`"publish"` rows, since
  integration tests run against the same Supabase project `.env` points the real worker at.

## Desired End State

- After every `scheduled-run.ts` tick (roughly every 15 minutes via the systemd timer), a ping
  reaches the configured healthchecks.io check: the plain success URL when every due job
  succeeded, the `/fail`-suffixed URL when any job errored. A missing `HEARTBEAT_PING_URL` is
  handled the same way every other optional integration handles absent config — the worker keeps
  running, nothing crashes, `not_configured` is logged quietly.
- A heartbeat delivery failure (network blip, provider outage) never changes `scheduled-run`'s own
  exit code — only the real job outcomes do.
- A new test demonstrates FR-027's catch-up working for all three real registered jobs
  (`collection`, `approval-reminder`, `publish`) after a simulated multi-week outage, without
  touching the real rows those names would claim in a shared database.
- `deploy/systemd/README.md` has a Heartbeat section an operator can follow on the real Pi;
  `.env.example` documents `HEARTBEAT_PING_URL` with healthchecks.io setup steps; CLAUDE.md lists
  the new opt-in live smoke test.
- The roadmap's S-10 entry is marked done, closing the last unshipped slice.

**Verification**: unit tests cover `sendHeartbeat`'s not_configured/success/fail/network-error
branches and `reportHeartbeat`'s logging/never-throws contract; the new catch-up test passes;
`HEARTBEAT_LIVE_SMOKE=1` (opt-in, requires a real healthchecks.io check) pings the real service and
its dashboard shows the ping; a manual local run of `npm run scheduled-run` shows the heartbeat
line in its log output.

## What We're NOT Doing

- No vendor-agnostic heartbeat abstraction — the code hardcodes healthchecks.io's URL convention
  (base URL for success, `/fail` suffix for failure), per the operator's explicit choice.
  Switching providers later is a code change, not a config change; this is intentional given the
  scale of this project.
- No error detail in the ping body — the `/fail` ping signals only pass/fail, not the underlying
  error text. The operator already has `scheduled_job.last_error` for specifics; keeping the ping
  itself a plain GET with no body keeps the module to one `fetch()` call.
- No retry on a failed heartbeat send — one attempt, matching `sendEmail`'s "no retry: one attempt,
  fail fast" convention. The next tick (≤15 minutes later) is the natural retry, and the monitor's
  own grace period is what actually absorbs a single missed ping.
- No new `npm run heartbeat` CLI entrypoint — the opt-in live smoke test is the on-demand
  verification mechanism, mirroring `SLIDES_LIVE_SMOKE`'s precedent (which also has no standalone
  script).
- No new production code for catch-up itself (FR-027) — F-05 already delivers it generically;
  this plan only adds verification.
- No live dry run against the real Raspberry Pi — this development environment has no Linux/
  systemd host, the same limitation `deploy/systemd/README.md` already documents for F-05. The
  Heartbeat section this plan adds carries the same "reviewed, not verified on hardware" caveat
  until the operator runs it on the real Pi.

## Implementation Approach

Two independent pieces: a new, self-contained heartbeat-sending module (Phase 1) wired into the
existing scheduler entrypoint (Phase 2), and a verification-only test proving FR-027 needs no new
code (Phase 3). Phase 4 closes out documentation and the deploy runbook; Phase 5 verifies
everything together.

## Critical Implementation Details

**The `/fail` URL suffix is a healthchecks.io-specific assumption, not a generic convention.**
`sendHeartbeat()` appends `/fail` to whatever `HEARTBEAT_PING_URL` is configured as when the tick
failed. This is exactly healthchecks.io's own ping API (a check's failure URL is always its
success URL plus `/fail`) and is the direct, deliberate consequence of the operator's choice not
to build a vendor-agnostic abstraction. A future switch to a different monitor provider needs a
code change here, not just a new `.env` value — worth a comment at the point of use so it isn't
mistaken for a general pattern.

## Phase 1: Heartbeat send module

### Overview

A new, self-contained module that pings an external dead-man's-switch and never throws, mirroring
the email harness's contract.

### Changes Required:

#### 1. Result type

**File**: `src/types.ts`

**Intent**: Add the typed result shape the heartbeat module returns, following the exact
documented pattern already used for `EmailResult`/`LlmResult`/`RunStateResult`.

**Contract**: Immediately after `EmailResult` (`src/types.ts:92`), add `HeartbeatErrorReason`
(`"not_configured" | "send_failed"`), `HeartbeatError`, and `HeartbeatResult = { ok: true } |
HeartbeatError`, with the same doc-comment style listing what each reason means (`not_configured`
— no `HEARTBEAT_PING_URL`; `send_failed` — the ping request failed or returned a non-2xx status).

#### 2. Send function

**File**: `src/lib/heartbeat/send.ts` (new)

**Intent**: One function, one `fetch()` call, never throws. No separate `client.ts` — there is no
real client to construct, just a URL read straight from worker env.

**Contract**:

```ts
export async function sendHeartbeat(
  fetchImpl: typeof fetch,
  pingUrl: string | undefined,
  outcome: { ok: boolean },
): Promise<HeartbeatResult>
```

Returns `not_configured` when `pingUrl` is undefined/empty, without calling `fetchImpl`. Otherwise
GETs `pingUrl` when `outcome.ok` is true, or `` `${pingUrl}/fail` `` when false (see Critical
Implementation Details). A non-2xx response or a thrown fetch error both return `send_failed` with
the status code or error message in `message`; anything else returns `{ ok: true }`.

#### 3. Unit tests

**File**: `src/lib/heartbeat/send.test.ts` (new)

**Intent**: Cover every branch with a fake `fetchImpl`, mirroring `graph-api.test.ts`'s
`vi.fn().mockResolvedValue(new Response(...))` style — no network, no real pings.

**Contract**: Cases: `not_configured` when `pingUrl` is undefined (and `fetchImpl` is never
called); a success outcome GETs the plain `pingUrl`; a failure outcome GETs `` `${pingUrl}/fail` ``;
a non-2xx response returns `send_failed` with the status in the message; a thrown/rejected fetch
returns `send_failed` with the underlying error message.

#### 4. Live smoke test

**File**: `src/lib/heartbeat/send.live.test.ts` (new)

**Intent**: One real ping against the operator's actual healthchecks.io check, mirroring
`send.live.test.ts`'s (email) and `slides.live.test.ts`'s opt-in shape exactly.

**Contract**: Opt-in via `HEARTBEAT_LIVE_SMOKE=1` plus `HEARTBEAT_PING_URL` set; skips otherwise.
Calls `sendHeartbeat(fetch, requireEnv("HEARTBEAT_PING_URL"), { ok: true })` and asserts
`result.ok`.

#### 5. Test env prefix

**File**: `vitest.config.ts`

**Intent**: Let the live smoke test see its own credential under Vitest.

**Contract**: Add `"HEARTBEAT_"` to the `loadEnv` prefix array (`vitest.config.ts:39`), alongside
the existing comment explaining why each prefix is listed.

### Success Criteria:

#### Automated Verification:

- New unit tests pass: `npm test -- heartbeat`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- None — this phase has no observable behavior on its own; it is not yet wired into the
  scheduler entrypoint.

---

## Phase 2: Wire into scheduled-run.ts

### Overview

Thread the new module into the real entrypoint: config, a testable wrapper, and the call site.

### Changes Required:

#### 1. Worker configuration

**File**: `src/worker/env.ts`

**Intent**: Give the operator a single optional config value, following the exact optional-field
convention every other integration in this file already uses.

**Contract**: Add `HEARTBEAT_PING_URL: z.url("HEARTBEAT_PING_URL must be a valid URL").optional()`,
with a comment naming S-10/FR-028 and noting the worker runs fine unconfigured (mirroring the
Gmail block's comment style).

#### 2. Heartbeat wrapper

**File**: `src/worker/scheduled-run.ts`

**Intent**: A `notifyDigestReady`-style wrapper: never throws, logs its own outcome, callable in
isolation from `main()` for direct unit testing.

**Contract**: Add `export async function reportHeartbeat(fetchImpl: typeof fetch, pingUrl: string
| undefined, ok: boolean): Promise<void>`. Calls `sendHeartbeat(fetchImpl, pingUrl, { ok })` and
logs: `console.log` on success, `console.log` (not `console.error`) on `not_configured` (mirroring
`remind.ts`'s "keep running quietly" precedent), `console.error` on `send_failed`. Never throws
and never returns a value the caller branches on — `main()`'s exit code depends only on the real
job outcomes.

#### 3. Call site

**File**: `src/worker/scheduled-run.ts`

**Intent**: Fire the ping once per tick, after job execution, unconditionally.

**Contract**: In `main()` (`scheduled-run.ts:163-169`), after `const ok = await
runScheduledJobs(...)` and before `return ok ? 0 : 1`, add `await reportHeartbeat(fetch,
env.HEARTBEAT_PING_URL, ok)`. The returned exit code expression is unchanged — heartbeat delivery
never affects it, by construction (its result is discarded).

#### 4. Unit tests

**File**: `src/worker/scheduled-run.test.ts`

**Intent**: Prove `reportHeartbeat`'s contract directly, the same way `notifyDigestReady` gets its
own tests rather than only being exercised through `main()`.

**Contract**: New `describe("reportHeartbeat")` block, fake `fetchImpl` (no DB needed — this
function has no Supabase dependency): resolves without throwing when `pingUrl` is undefined;
resolves without throwing when the fake fetch rejects; GETs the plain URL when `ok` is true and
the `/fail`-suffixed URL when `ok` is false.

### Success Criteria:

#### Automated Verification:

- Existing scheduled-run tests still pass: `npm test -- scheduled-run`
- New `reportHeartbeat` unit tests pass
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- Running `npm run scheduled-run` locally without `HEARTBEAT_PING_URL` set completes normally and
  logs a quiet "not configured" heartbeat line, with no change to the command's own exit code.

---

## Phase 3: Catch-up verification for the real job registry

### Overview

Prove FR-027 already works for the actual production job list, not just synthetic single-job
cases — without touching the real rows those job names would claim in a shared database.

### Changes Required:

#### 1. Registry-wide catch-up test

**File**: `src/worker/scheduled-run.test.ts`

**Intent**: Demonstrate that every entry in the real `SCHEDULED_JOBS` registry, after a simulated
multi-week outage, is caught up correctly in one pass — the concrete evidence for closing FR-027,
distinct from the existing tests which only ever exercise one synthetic job at a time.

**Contract**: New test mapping over the real `SCHEDULED_JOBS` array, building one synthetic
`{ name: nextJobName(), schedule: job.schedule }` per real entry (reusing `TEST_JOB_PREFIX`
isolation — never the real `"collection"`/`"approval-reminder"`/`"publish"` names), with `now` set
several weeks past each schedule's most recent occurrence. Asserts `runScheduledJobs` claims and
runs all of them in one pass (`callCount()` per job reaches 1) and that each resulting row's
`status` returns to `idle` with `last_error: null` — proving the "any outage length collapses to
one catch-up fire" guarantee holds across the whole real registry, not just the two schedules
already spot-checked.

### Success Criteria:

#### Automated Verification:

- New test passes: `npm test -- scheduled-run`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- None — this phase adds regression coverage only.

---

## Phase 4: Docs & deploy runbook

### Overview

Document the new config for both a fresh local setup and the real Pi deployment, and close out
the roadmap slice.

### Changes Required:

#### 1. Environment example

**File**: `.env.example`

**Intent**: Give the operator the same copy-pasteable setup block every other optional
integration already has.

**Contract**: Add a `HEARTBEAT_PING_URL` block naming S-10/FR-028, with brief healthchecks.io
setup steps (create a check, set its grace period to comfortably exceed the 15-minute tick
cadence — e.g. 30 minutes — and paste its ping URL), following the numbered-steps style already
used for the Meta/LinkedIn blocks.

#### 2. Deploy runbook

**File**: `deploy/systemd/README.md`

**Intent**: Extend the existing, already-reviewed runbook with the Pi-specific heartbeat setup
and verification steps, rather than starting a second deploy doc.

**Contract**: Add a "Heartbeat" section: create the healthchecks.io check, add
`HEARTBEAT_PING_URL` to the Pi's `.env` alongside the existing variables, and a verification step
(trigger the service once by hand, per the existing "Verify" section, then confirm the
healthchecks.io dashboard shows a recent ping). Carries the same "reviewed, not verified on real
hardware" caveat the rest of the file already states.

#### 3. Command reference

**File**: `CLAUDE.md`

**Intent**: Keep the onboarding doc's command list complete, matching every other opt-in live
smoke test's existing bullet.

**Contract**: Add a bullet for `HEARTBEAT_LIVE_SMOKE=1 npx vitest run
src/lib/heartbeat/send.live.test.ts`, in the same style and list position as the other
`*_LIVE_SMOKE` bullets.

#### 4. Roadmap close-out

**File**: `context/foundation/roadmap.md`

**Intent**: Mark S-10 done now that both FR-027 (verified) and FR-028 (delivered) are complete,
matching the convention used for every other shipped slice.

**Contract**: Update S-10's `Status:` field (and the at-a-glance table row, and the backlog
handoff table row) from `proposed` to `done (shipped <date>, commits <first>…<last>)`, following
the exact three-location pattern S-09's own close-out just established.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- `deploy/systemd/README.md`'s new section reads correctly as a standalone procedure (no
  dangling references to steps earlier in the file that don't exist).

---

## Phase 5: End-to-end verification

### Overview

Confirm everything works together and the opt-in live path is genuinely exercisable.

### Changes Required:

None — this phase runs verification only.

### Success Criteria:

#### Automated Verification:

- Full test suite passes: `npm test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Production build succeeds: `npm run build`

#### Manual Verification:

- Operator creates a real healthchecks.io check, sets `HEARTBEAT_PING_URL` locally, and runs
  `HEARTBEAT_LIVE_SMOKE=1 npx vitest run src/lib/heartbeat/send.live.test.ts` — passes, and the
  healthchecks.io dashboard shows the ping.
- A local `npm run scheduled-run` with `HEARTBEAT_PING_URL` set shows a successful heartbeat log
  line and the dashboard reflects it.
- Real Pi deployment (installing the updated runbook's Heartbeat section on the actual hardware)
  remains a carried-forward manual step, per "What We're NOT Doing" — not verifiable from this
  development environment.

---

## Testing Strategy

### Unit Tests:

- `sendHeartbeat`: not_configured, success ping URL, fail ping URL (`/fail` suffix), non-2xx
  response, thrown fetch error
- `reportHeartbeat`: never throws regardless of `sendHeartbeat`'s outcome; logs appropriately;
  GETs the correct URL variant based on `ok`

### Integration Tests:

- Registry-wide catch-up test (Phase 3) against the real `SCHEDULED_JOBS` schedules, using
  isolated synthetic job names

### Manual Testing Steps:

1. Run `npm run scheduled-run` locally with no `HEARTBEAT_PING_URL` set — completes normally,
   logs a quiet not-configured line.
2. Create a real healthchecks.io check, set `HEARTBEAT_PING_URL`, run
   `HEARTBEAT_LIVE_SMOKE=1 npx vitest run src/lib/heartbeat/send.live.test.ts` — passes, dashboard
   shows the ping.
3. Run `npm run scheduled-run` locally with `HEARTBEAT_PING_URL` set — logs a successful heartbeat
   line; dashboard reflects it.

## Performance Considerations

One additional `fetch()` call per `scheduled-run` tick (~every 15 minutes) — negligible; no
retries, no polling, no added load on the pipeline's own database or LLM calls.

## Migration Notes

No schema migration required — this plan touches no database tables. `HEARTBEAT_PING_URL` is a
new optional environment variable with no default, matching every other optional integration in
`src/worker/env.ts`.

## References

- Roadmap: `context/foundation/roadmap.md` (S-10 entry)
- PRD: `context/foundation/prd.md` (FR-027, FR-028, US-23, US-24)
- Scheduler backbone: `context/archive/2026-07-29-reliable-scheduler-backbone/plan.md`
- Email harness precedent: `src/lib/email/send.ts`, `src/lib/email/send.live.test.ts`
- Deploy runbook: `deploy/systemd/README.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not
> rename step titles. See `references/progress-format.md`.

### Phase 1: Heartbeat send module

#### Automated

- [x] 1.1 New unit tests pass: `npm test -- heartbeat` — 8ac0cca
- [x] 1.2 Type checking passes: `npm run typecheck` — 8ac0cca
- [x] 1.3 Linting passes: `npm run lint` — 8ac0cca

### Phase 2: Wire into scheduled-run.ts

#### Automated

- [x] 2.1 Existing scheduled-run tests still pass: `npm test -- scheduled-run` — 82d8636
- [x] 2.2 New `reportHeartbeat` unit tests pass — 82d8636
- [x] 2.3 Type checking passes: `npm run typecheck` — 82d8636
- [x] 2.4 Linting passes: `npm run lint` — 82d8636

#### Manual

- [x] 2.5 `npm run scheduled-run` without `HEARTBEAT_PING_URL` completes normally, exit code
      unaffected — 82d8636

### Phase 3: Catch-up verification for the real job registry

#### Automated

- [x] 3.1 New registry-wide catch-up test passes: `npm test -- scheduled-run` — 6dd13c2
- [x] 3.2 Type checking passes: `npm run typecheck` — 6dd13c2
- [x] 3.3 Linting passes: `npm run lint` — 6dd13c2

### Phase 4: Docs & deploy runbook

#### Automated

- [x] 4.1 Type checking passes: `npm run typecheck` — bb3f49e
- [x] 4.2 Linting passes: `npm run lint` — bb3f49e

#### Manual

- [x] 4.3 `deploy/systemd/README.md`'s new Heartbeat section reads correctly as a standalone
      procedure — bb3f49e

### Phase 5: End-to-end verification

#### Automated

- [x] 5.1 Full test suite passes: `npm test`
- [x] 5.2 Type checking passes: `npm run typecheck`
- [x] 5.3 Linting passes: `npm run lint`
- [x] 5.4 Production build succeeds: `npm run build`

#### Manual

- [x] 5.5 `HEARTBEAT_LIVE_SMOKE=1` run passes against a real healthchecks.io check
- [x] 5.6 Local `npm run scheduled-run` with `HEARTBEAT_PING_URL` set shows a successful heartbeat
      log line, reflected on the dashboard
- [x] 5.7 Real Pi deployment acknowledged as a carried-forward manual step, not verified here
