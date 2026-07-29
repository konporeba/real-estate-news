# Reliable Scheduler Backbone (F-05) Implementation Plan

## Overview

F-05 is the roadmap's scheduling foundation: a mechanism that fires the weekly pipeline at
the correct Europe/Warsaw wall-clock time year-round — across the DST transition — and
catches up a run that was missed while the Raspberry Pi was off, rather than silently
skipping it (FR-027, FR-022, NFR "Correct-time publishing"). Today, `npm run collect` and
`npm run rank` are 100% manual. This plan builds the primitive that lets them fire
automatically, and generalizes it so S-08 (Tuesday publish) can register into it later
without re-touching the scheduling core.

## Current State Analysis

- **Nothing schedules anything today.** `src/worker/collect.ts` and `src/worker/rank.ts`
  are one-shot CLI entrypoints (`tsx --env-file=.env`), invoked manually per
  `CLAUDE.md`'s Commands section. `rank` is a fully separate manual step from `collect`.
- **Catch-up is already half-solved at the domain layer.** `collect.ts`'s
  `resolveTargetDigest` already prefers "the newest recoverable (non-terminal or failed)
  digest" over creating a fresh one for the current week (`src/worker/collect.ts:49-74`),
  and `src/lib/collection/window.ts`'s checkpoint-based tiling means a late or repeated
  invocation is safe — it re-offers articles the previous run may have already seen and
  the insert's `ON CONFLICT` dedupe absorbs it. What's missing is the *invocation itself*
  ever happening automatically.
- **DST-correct zoned math is an established codebase convention, not a library.**
  `src/lib/collection/window.ts` computes week boundaries using
  `Intl.DateTimeFormat({ timeZone: "Europe/Warsaw" })` with a documented two-pass
  offset-resolution technique for DST-transition dates, explicitly avoiding a date
  library ("Intl is the whole mechanism; no date library is needed"). This plan follows
  that precedent rather than adding `luxon`/`date-fns-tz`.
- **No deployment infrastructure exists yet.** There is no `context/foundation/infrastructure.md`
  (the `/10x-infra-research` step hasn't run). `shape-notes.md` names a systemd timer with
  `Persistent=true` only as a *candidate* mechanism. Development happens on Windows; the
  target Raspberry Pi is not a configured environment in this repo. Prior migrations
  (`context/archive/2026-07-22-durable-digest-run-state/plan.md`) record that port 5432 has
  been unreachable from the dev machine at times, requiring a SQL-Editor-plus-manual-history
  workaround for `supabase db push` — later migrations (F-02's `pin-lockout` migration)
  applied cleanly via `db push`, so this plan assumes the normal path works but names the
  fallback.
- **Result-idiom convention is established three times over** (`RunStateResult`/`RunStateError`
  in `src/lib/digest/run-state.ts`, `LlmResult`/`LlmError`, `EmailResult`/`EmailError`, all in
  `src/types.ts`): `{ ok: true, data }` or `{ ok: false, reason, message }`, never throwing for
  expected outcomes. This plan adds a fourth: `SchedulerResult`/`SchedulerError`.
- **Migration conventions**: deny-by-default RLS (service-role only), a reusable
  `set_updated_at()` trigger function already defined by the F-01 migration, and a naming
  format of `YYYYMMDDHHmmss_short_description.sql`.

## Desired End State

`npm run scheduled-run` is a new worker entrypoint that, invoked at any time (manually, by
cron, or by a systemd timer), checks whether the registered "collection" job is due —
correctly across DST, and correctly catching up a run missed for any length of time,
collapsed to a single fire — and if so, runs collection followed by ranking in sequence,
recording the outcome. A concurrent invocation while a run is already in progress is a
safe no-op, except when the previous run's lock has gone stale (crashed process), in which
case it is safely reclaimed. Systemd unit files exist as a documented, reviewed deployment
artifact for the eventual Pi, explicitly flagged as pending real-hardware verification.

**Verification:** `npm test` passes, including DST-transition-pinned unit tests for the
scheduling math and integration tests for the job-state store; `npm run lint` and
`npx astro check` pass; running `npm run scheduled-run` twice in a row (nothing due the
second time) and once with a fabricated overdue `last_fired_at` (fires) both behave as
designed against a real Supabase test project.

### Key Discoveries:

- `src/worker/collect.ts:133-163` and `src/worker/rank.ts:111-140` both export a plain
  `async function main(argv): Promise<number>` that never calls `process.exit` itself (only
  the file's own `import.meta.url` guard does) — so the new entrypoint can call both
  directly, in-process, without shelling out to `npm run collect && npm run rank`.
- `collect()` (`src/lib/collection/collect.ts:303`) already transitions a successful digest
  to `"ranking"` — chaining rank after collect is just "call rank's main() next," not a new
  state-machine concern.
- `transitionDigest` (`src/lib/digest/run-state.ts:83-115`) demonstrates the codebase's
  optimistic-concurrency pattern: scope the update to the previously-read value
  (`.eq("status", from)`) so a concurrent writer gets a named failure instead of silently
  clobbering state. The job-lock release in this plan follows the same pattern.
- `eslint.config.js`'s `runtimeBoundaryConfig` (`src/lib/collection/**`, `src/lib/llm/**`,
  `src/lib/email/**`, `src/worker/**`) is the worker-only import boundary; `src/lib/digest/**`
  is deliberately outside it (shared, client-as-parameter). The new `src/lib/scheduler/`
  module is worker-only — nothing in the Astro app reads scheduler state in this slice — so
  it's added to the same restricted-imports group as `collection`/`llm`/`email`.

## What We're NOT Doing

- The Tuesday publish job itself (S-08 doesn't exist yet) — only the registry hook point
  that lets it register a schedule with zero changes to the scheduling core.
- Heartbeat / dead-man's-switch alerting (S-10) — this plan only makes `last_fired_at` /
  `last_completed_at` state queryable for S-10 to read later; it adds no external ping.
- Any retry/backoff logic beyond "the next scheduled fire (or FR-018's existing manual
  re-trigger) recovers a failed run" — no scheduler-level retry loop.
- A dashboard view of scheduler status — nothing in `src/pages/` reads the new table in
  this slice.
- Provisioning the actual Raspberry Pi, running `systemctl enable` for real, or verifying
  the systemd units against real hardware — they ship as reviewed, documented artifacts
  with real-hardware verification explicitly deferred.
- A second notification channel, ranking retry policy changes, or anything under S-01/S-02's
  existing scope — this plan only adds the trigger, not new pipeline behavior.

## Implementation Approach

A **hybrid** design: the correctness-critical logic — "is this job due, accounting for DST
and any length of catch-up" and "is a previous run of this job still genuinely in
progress" — lives entirely in testable, pure-or-thin-DB TypeScript (`src/lib/scheduler/`),
independent of whatever invokes it. The OS-level piece (systemd timer) is deliberately
*dumb*: it just runs `npm run scheduled-run` frequently (every 15 minutes), so its own
timing precision doesn't need to be trusted — even a late or repeated OS-level trigger
produces the same correct outcome, because the in-repo due-check is authoritative.
`Persistent=true` on the timer is a backstop for the case the Pi is off long enough to miss
the frequent cadence itself.

A generic named-job registry (`src/lib/scheduler/registry.ts`) holds one entry today
("collection", Sunday 17:00 Europe/Warsaw — the hour the PRD's own text uses as the
collection trigger reference point). S-08 adds a "publish" entry later with no changes to
`src/lib/scheduler/schedule.ts` or the orchestration entrypoint's due-check loop.

## Critical Implementation Details

### Timing & lifecycle: DST-correct "most recent scheduled instant"

The due-check is not "did 7 days pass since last fire" (which would drift and wouldn't
naturally collapse multi-week outages) — it's "what is the most recent instant, at or
before now, that this job's weekly schedule specifies, and is `last_fired_at` older than
that." Computing the "most recent scheduled instant" for a given `now` follows
`window.ts`'s established two-pass technique: find the most recent zoned calendar date
(walking back up to 7 days) whose day-of-week matches the schedule, resolve that date's
scheduled hour:minute to a UTC instant using the offset-guess-then-refine approach (the
second pass is what makes the DST-transition date itself correct, since the offset before
and after the transition differ), and if that instant is still in the future relative to
`now` (the scheduled day hasn't reached its hour yet), step back a further 7 days to the
prior occurrence. Because `isJobDue` only ever compares against this single most-recent
instant — never enumerating every individually-missed week — a two-week outage collapses
to exactly one fire, satisfying "bounded by one week's worth of jobs."

### State sequencing: lock release must not clobber a newer run

`tryAcquireJob` claims the row by writing `status = 'running', started_at = now` in one
atomic upsert, conditioned on the row being `idle` OR `running` with a `started_at` older
than a stale-lock threshold (3 hours — comfortably longer than collection + ranking should
ever take, including LLM retries, but short enough to self-heal within the same day after a
crash). The row it claims carries a `started_at` value unique to that invocation. The
matching `releaseJob` call must scope its update to `where started_at = <that same value>`
(mirroring `transitionDigest`'s `.eq("status", from)` pattern) — not just `where name = X`
— because a genuinely slow (not crashed) run that gets stale-reclaimed by a fresh invocation
and then finally finishes must not be allowed to overwrite the fresh invocation's state when
it calls `releaseJob` after the fact.

## Phase 1: Job-state data model

### Overview

Persist per-job scheduling state — is it currently running, when did it last fire, when
did it last complete, what was the last error — so the orchestration entrypoint (Phase 3)
has something to check and claim across separate process invocations.

### Changes Required:

#### 1. Migration: `scheduled_job` table

**File**: `supabase/migrations/20260729180000_scheduled_job_state.sql`

**Intent**: One row per named job. No `next_due_at` column — due-ness is always derived
from the schedule spec (defined in code, Phase 2) plus this row's `last_fired_at`, so there
is nothing to keep in sync or let go stale.

**Contract**: `scheduled_job (name text primary key, status scheduled_job_status not null
default 'idle', started_at timestamptz, last_fired_at timestamptz, last_completed_at
timestamptz, last_error text, updated_at timestamptz not null default now())`, where
`scheduled_job_status` is a new enum `('idle', 'running')`. Reuse the existing
`set_updated_at()` trigger function from the F-01 migration rather than redefining it.
Deny-by-default RLS (`alter table scheduled_job enable row level security;`, no policies),
matching `digest`/`cluster`/`article`. No seed row — `tryAcquireJob` (Phase 3) upserts a
row for a job name on its first invocation, so adding a future job (S-08's "publish") never
needs a new migration.

#### 2. Regenerate types

**File**: `src/db/database.types.ts`

**Intent**: Pick up the new table/enum.

**Contract**: `npx supabase gen types typescript --project-id <ref> > src/db/database.types.ts`
(or `--local`), per the existing convention noted in `run-state.ts`'s header.

#### 3. Shared types

**File**: `src/types.ts`

**Intent**: A fourth result idiom, matching `RunStateResult`/`LlmResult`/`EmailResult`.

**Contract**: `ScheduledJobRow = Database["public"]["Tables"]["scheduled_job"]["Row"]`;
`SchedulerErrorReason = "job_already_running" | "database_error"`; `SchedulerError { ok:
false; reason: SchedulerErrorReason; message: string }`; `SchedulerResult<T> = { ok: true;
data: T } | SchedulerError`.

#### 4. Job-state store

**File**: `src/lib/scheduler/store.ts`

**Intent**: Runtime-neutral (client-as-parameter, like `src/lib/digest/run-state.ts`) CRUD
over `scheduled_job`: read a job's row (or a default idle shape if no row exists yet),
atomically claim it, and release it.

**Contract**: `getJobState(client, name): Promise<SchedulerResult<ScheduledJobRow | null>>`;
`tryAcquireJob(client, name, now, staleAfterMs): Promise<SchedulerResult<ScheduledJobRow>>`
— an atomic upsert that claims the row when it's `idle` or `running`-but-stale, returning
`{ ok: false, reason: "job_already_running" }` when a genuinely active run holds it;
`releaseJob(client, name, claimedStartedAt, outcome: { completedAt: Date; error?: string |
null }): Promise<SchedulerResult<ScheduledJobRow>>` — scoped to `started_at =
claimedStartedAt` per the State Sequencing detail above, itself returning
`job_already_running`-shaped failure (harmless — just logged) if that row was already
reclaimed by someone else.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly against the local/test Supabase project: `npx supabase db push`
  (or the project's established migration-apply workaround if port 5432 is unreachable from
  this machine, per the F-01/F-03 precedent)
- Types regenerate without error and `npx astro check` passes
- `npm run lint` passes
- Integration tests pass (`SUPABASE_TEST_PROJECT=1 npm test`): claim-when-idle,
  claim-rejected-when-genuinely-running, claim-succeeds-when-stale, release-scoped-to-claim
  rejects a stale release attempt

#### Manual Verification:

- Inspect the applied schema in Supabase Studio (or `psql \d scheduled_job`): enum, table,
  deny-by-default RLS, and the reused `set_updated_at` trigger are all present

---

## Phase 2: Scheduler core (DST-correct due-check)

### Overview

Pure, dependency-free functions computing "the most recent instant this job's weekly
schedule specifies" and "is this job due," plus the job registry. Fully unit-testable with
explicit `now` injection — no fake timers, matching `window.test.ts`'s existing convention
of passing `now`/`instant` as an argument.

### Changes Required:

#### 1. Zoned schedule math

**File**: `src/lib/scheduler/schedule.ts`

**Intent**: Compute due-ness without a date library, following `window.ts`'s
`Intl.DateTimeFormat`-based zoned-math technique (see Critical Implementation Details).

**Contract**: `interface WeeklySchedule { dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; hour: number;
minute: number }` (0 = Sunday, matching `Date#getUTCDay()` applied to zoned date parts, same
convention as `window.ts`'s `currentWeekWindow`); `mostRecentScheduledInstant(schedule:
WeeklySchedule, now: Date): Date`; `isJobDue(schedule: WeeklySchedule, lastFiredAt: Date |
null, now: Date): boolean`.

#### 2. Job registry

**File**: `src/lib/scheduler/registry.ts`

**Intent**: The single place naming which jobs exist and when they run — data only, no
worker-side action logic (that stays in Phase 3's entrypoint, keeping this module free of
`@/lib/collection`/`@/lib/llm` imports).

**Contract**: `interface ScheduledJobDefinition { name: string; schedule: WeeklySchedule }`;
`SCHEDULED_JOBS: readonly ScheduledJobDefinition[]` with one entry: `{ name: "collection",
schedule: { dayOfWeek: 0, hour: 17, minute: 0 } }` (Sunday 17:00 Europe/Warsaw).

### Success Criteria:

#### Automated Verification:

- Unit tests pass (`npm test`): `mostRecentScheduledInstant` pinned to real DST-transition
  dates (2026's last-Sunday-in-March spring-forward and last-Sunday-in-October fall-back,
  in both Poland's and Spain's shared CET/CEST zone) return the correct instant on both
  sides of the transition; `isJobDue` correctly fires for a null `lastFiredAt`, doesn't fire
  for a `lastFiredAt` after the most recent scheduled instant, and collapses a two-week gap
  to a single due=true
- `npm run lint` and `npx astro check` pass

#### Manual Verification:

- None beyond automated — this module is pure and fully covered by unit tests

---

## Phase 3: Orchestration entrypoint

### Overview

A new worker entrypoint that ties Phases 1–2 together with the actual job actions
(collection → rank), safe to invoke as often as every 15 minutes.

### Changes Required:

#### 1. Scheduled-run entrypoint

**File**: `src/worker/scheduled-run.ts`

**Intent**: For each job in `SCHEDULED_JOBS`, check due-ness, attempt to claim it, run its
action if claimed, and release the claim — logging every outcome (due/not-due,
claimed/already-running, succeeded/failed) so a human reading the log (or, later, S-10)
can tell what happened without guessing.

**Contract**: `main(now?: Date): Promise<number>`, following `collect.ts`/`rank.ts`'s
existing pattern (plain function returning an exit code, `process.exit` only in the
`import.meta.url` guard). The "collection" job's action calls `collect.ts`'s exported
`main()` and, only if it returns `0`, `rank.ts`'s exported `main()` next — per the Key
Discoveries note, this needs no new chaining mechanism beyond calling both functions in
sequence. A job whose collect step fails is released with the failure recorded and rank is
skipped for that cycle; the next scheduled fire (or a manual `npm run collect`) picks the
still-recoverable digest back up, per the "no special scheduler-level retry" decision.

#### 2. npm script

**File**: `package.json`

**Intent**: Manual invocability, matching `collect`/`rank`.

**Contract**: `"scheduled-run": "tsx --env-file=.env src/worker/scheduled-run.ts"`.

### Success Criteria:

#### Automated Verification:

- Integration tests pass (`SUPABASE_TEST_PROJECT=1 npm test`): not-due is a no-op (no job
  action invoked); due-and-claimable runs the action and records `last_fired_at` /
  `last_completed_at`; due-but-genuinely-running skips with a logged reason and does not
  invoke the action twice; due-but-stale-lock reclaims and runs
- `npm run lint` and `npx astro check` pass

#### Manual Verification:

- Run `npm run scheduled-run` twice back-to-back against a real (test) digest: the second
  run logs "not due" and performs no work
- Manually set a test job's `last_fired_at` to more than a week ago, run `npm run
  scheduled-run`, and confirm it drives a real collect → rank cycle exactly as `npm run
  collect` followed by `npm run rank` would

**Implementation Note**: Pause here for manual confirmation before Phase 4.

---

## Phase 4: OS wiring & documentation

### Overview

Ship the actual invoker for the real Pi, honestly scoped: reviewed and documented, not
verified against real hardware in this session.

### Changes Required:

#### 1. Systemd unit files

**File**: `deploy/systemd/real-estate-news-scheduled-run.service`,
`deploy/systemd/real-estate-news-scheduled-run.timer`

**Intent**: A thin, frequent invoker of `npm run scheduled-run`; DST-correctness and
catch-up are the in-repo core's job (Phase 2), not the timer's — this timer only needs to
fire *often enough*, not *precisely*.

**Contract**:

```ini
# real-estate-news-scheduled-run.timer
[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
```

The paired `.service` unit runs `npm run scheduled-run` with `WorkingDirectory` set to the
deployed repo path and `EnvironmentFile` pointing at the production `.env`. `Persistent=true`
is the backstop for an outage long enough to miss the 15-minute cadence itself — on boot,
systemd fires once immediately, and the in-repo due-check decides whether that fire
actually needs to do anything.

#### 2. Deployment runbook

**File**: `deploy/systemd/README.md`

**Intent**: Install/verify/troubleshoot steps for the operator's eventual Pi setup —
`systemctl enable --now`, confirming the timer with `systemctl list-timers`, reading logs
via `journalctl -u real-estate-news-scheduled-run.service`.

**Contract**: A short runbook; explicitly states real-hardware verification is outstanding
(see Manual Verification below).

#### 3. Documentation

**File**: `CLAUDE.md`

**Intent**: A section mirroring F-03/F-04's, describing `npm run scheduled-run`, the
`SCHEDULED_JOBS` registry, and where the systemd artifacts live.

**Contract**: Follows the existing `## LLM calls go through the harness (F-03)` /
`## Outbound email goes through the harness (F-04)` heading pattern.

### Success Criteria:

#### Automated Verification:

- `npm run lint` and `npm test` pass (no code changes in this phase beyond docs/config, so
  this is a regression check)

#### Manual Verification:

- The unit files and runbook are reviewed for syntax and correctness by careful reading
  (no local systemd/Linux available in this environment)
- Explicitly flagged in this plan's Progress as **pending verification against the real
  Raspberry Pi** — not claimed as tested

---

## Testing Strategy

### Unit Tests:

- `schedule.test.ts`: DST-transition-pinned instants (spring-forward and fall-back), the
  "hasn't reached the hour yet today" branch, multi-week catch-up collapsing to one due=true

### Integration Tests:

- `store.test.ts`: claim/release/stale-reclaim against the real (test) Supabase project,
  following `run-state.test.ts`'s synthetic-window-and-cleanup convention
- `scheduled-run.test.ts`: end-to-end not-due / due-and-claim / already-running /
  stale-reclaim against a real test digest

### Manual Testing Steps:

1. Run `npm run scheduled-run` with nothing due — confirm a clean no-op log line and no
   digest/job-state changes.
2. Force a due state (backdate `last_fired_at`) and run it — confirm collect → rank both
   execute and job state updates.
3. Review the systemd unit files and runbook for correctness (no real Pi available this
   session).

## Performance Considerations

None beyond what Phase 3's Key Discoveries already note — this reuses collect/rank as-is;
no new LLM or network calls are introduced by the scheduler itself.

## Migration Notes

First-time table; no existing data to migrate. Adding a second job (S-08's "publish") later
needs no migration — `tryAcquireJob` upserts on first use.

## References

- Roadmap: `context/foundation/roadmap.md` (F-05)
- PRD: `context/foundation/prd.md` (FR-022, FR-027, FR-028, NFR "Correct-time publishing")
- Forward tech-stack notes: `context/foundation/shape-notes.md` §"Forward: tech-stack —
  Hosting & Deployment Constraints"
- DST-correct zoned-math precedent: `src/lib/collection/window.ts`
- Optimistic-concurrency precedent: `src/lib/digest/run-state.ts:83-115` (`transitionDigest`)
- Chainable worker entrypoints: `src/worker/collect.ts:133-163`, `src/worker/rank.ts:111-140`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Job-state data model

#### Automated

- [x] 1.1 ~~`npx supabase db push`~~ → both `db push` and the Supabase MCP tools were blocked this session (CLI: 403 "account does not have the necessary privileges" on the linked cloud project, same class of issue as F-01/F-03; MCP: authenticated to a different Supabase account entirely). Applied and verified cleanly instead against a local Docker Supabase stack (`npx supabase db reset`). **The real cloud project still needs this migration applied** — carried forward, same as F-01's precedent. — b190e0a
- [x] 1.2 Types regenerate (hand-spliced into the existing file per its documented EXCEPTION mechanism, not a wholesale regen — see below); `npx astro check` passes (2 pre-existing unrelated errors in `src/lib/auth/{pin,session}.ts` confirmed present on a clean stash, not introduced by this phase) — b190e0a
- [x] 1.3 `npm run lint` passes — b190e0a
- [x] 1.4 Integration tests pass (`SUPABASE_TEST_PROJECT=1 npm test`, against the local stack): claim/release/stale-reclaim behavior — 21/21 passed, including the pre-existing `run-state` suite (no regression) — b190e0a

#### Manual

- [x] 1.5 Schema inspected in Studio/psql: enum, table, RLS, reused trigger all present — b190e0a

### Phase 2: Scheduler core (DST-correct due-check)

#### Automated

- [x] 2.1 Unit tests pass: DST-transition-pinned `mostRecentScheduledInstant` and `isJobDue` cases — 8/8 passed on first run (2026-03-29 spring-forward, 2026-10-25 fall-back, mid-week resolution, multi-week collapse) — 2cb1601
- [x] 2.2 `npm run lint` and `npx astro check` pass (same 2 pre-existing, unrelated `src/lib/auth/*` errors as Phase 1, no new errors) — 2cb1601

### Phase 3: Orchestration entrypoint

#### Automated

- [x] 3.1 Integration tests pass: not-due no-op, due-and-claim, already-running skip, stale-reclaim — 5/5 passed, against fake job actions (not the real collect/rank chain — see 3.3/3.4 note) — 6ec1f0d
- [x] 3.2 `npm run lint` and `npx astro check` pass (same 2 pre-existing unrelated errors, no new ones) — 6ec1f0d

#### Manual

- [x] 3.3 `npm run scheduled-run` run twice back-to-back: second run is a no-op — 6ec1f0d
- [x] 3.4 Backdated `last_fired_at` drives a real collect → rank cycle via `npm run scheduled-run` — 6ec1f0d

### Phase 4: OS wiring & documentation

#### Automated

- [x] 4.1 `npm run lint` and `npm test` pass (regression check) — 258 passed / 11 skipped against the local stack, no new failures — 44925be

#### Manual

- [x] 4.2 Systemd unit files and runbook reviewed for correctness — 44925be
- [x] 4.3 Explicitly recorded as pending verification against the real Raspberry Pi — 44925be
