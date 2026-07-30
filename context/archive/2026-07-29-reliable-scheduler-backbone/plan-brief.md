# Reliable Scheduler Backbone (F-05) — Plan Brief

> Full plan: `context/changes/reliable-scheduler-backbone/plan.md`

## What & Why

The roadmap's F-05 foundation: a scheduling primitive that fires the weekly pipeline at the
correct Europe/Warsaw wall-clock time year-round — across the DST transition — and catches
up a run missed while the Raspberry Pi was off, instead of silently skipping it. Today
`npm run collect` and `npm run rank` are 100% manual; this is what will let Sunday
collection (and later, Tuesday publish) fire on their own.

## Starting Point

No scheduling code exists. `collect.ts` already tolerates a late/repeated invocation
gracefully (it finds the newest recoverable digest before creating a new one), so the real
gap is that nothing ever triggers it automatically. `window.ts` already established a
DST-correct, dependency-free pattern (`Intl.DateTimeFormat` with `timeZone:
"Europe/Warsaw"`) for exactly this kind of zoned-time math — this plan extends that
pattern rather than introducing a date library. No deployment infrastructure
(`infrastructure.md`) exists yet, and dev happens on Windows, not the target Pi.

## Desired End State

`npm run scheduled-run` — invokable manually, by cron, or by a systemd timer — checks
whether the registered "collection" job is due (correctly, across any length of outage) and
if so runs collection then ranking automatically, recording the outcome. A crashed or
overlapping run can't wedge the job or double-fire it. Systemd unit files exist as reviewed,
documented deployment artifacts, explicitly flagged as pending real-hardware verification.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Architecture | Hybrid: testable in-repo due-check core + a dumb, frequent OS-level trigger | Correctness (DST, catch-up) lives in unit-testable TypeScript regardless of what invokes it; the OS trigger only needs to fire often, not precisely. |
| OS wiring | Ship systemd `.service`/`.timer` files now, as documented artifacts | F-05 shouldn't leave a gap for the eventual infra step, even though no real Pi exists to verify against yet. |
| Rank chaining | Auto-chain `rank` after a successful `collect` in the scheduled path | "Automatic Sunday collection" only delivers real value if ranking also happens without a human remembering a second manual step. |
| Generality | A generic named-job registry, "collection" as its only entry today | S-08's Tuesday publish plugs in later with zero changes to the scheduling core — the actual meaning of "backbone." |
| Data model | New minimal `scheduled_job` table (no `next_due_at` — always derived) | Generalizes cleanly to jobs (like publish) that aren't tied to a digest-creation event; deriving due-ness from the schedule spec avoids a column that could drift out of sync. |
| Concurrency | Lightweight claim/stale-reclaim lock, not just trusting idempotency | Collection's idempotency covers safe re-runs, but not two invocations literally overlapping; a home-Pi unattended process can crash mid-run. |
| Failure handling | No scheduler-level retry — next fire or FR-018's manual re-trigger recovers | Reuses the already-built, already-tested recovery path instead of duplicating retry logic the scheduler would fight with. |
| S-10 handoff | Expose `last_fired_at`/`last_completed_at` as queryable now, no alerting | Near-zero extra cost since the data already exists for the scheduler's own use; avoids S-10 reverse-engineering state later. |
| DST test strategy | Fake-clock-free unit tests pinned to real DST transition dates | Matches `window.test.ts`'s existing convention of injecting `now` directly rather than global fake timers. |
| Manual verification (OS wiring) | Written runbook + syntax review, explicitly marked pending real hardware | Honest about what could/couldn't be verified without a Linux/systemd environment in this session. |
| Outage scope | Catch-up handles any outage length, collapsed to one fire | Matches FR-027's plain wording; a multi-day home-Pi outage is exactly the scenario the requirement exists for. |

## Scope

**In scope:** `scheduled_job` table + migration, a DST-correct pure due-check core
(`src/lib/scheduler/`), a job registry, a `scheduled-run` worker entrypoint chaining
collect → rank, concurrency/stale-lock handling, systemd unit files + runbook, `CLAUDE.md`
documentation.

**Out of scope:** the Tuesday publish job itself (S-08); heartbeat/alerting (S-10, though
this plan leaves the data it will need queryable); scheduler-level retry/backoff; a
dashboard view of scheduler status; provisioning or testing against the real Raspberry Pi.

## Architecture / Approach

`src/lib/scheduler/schedule.ts` computes "the most recent instant, at or before now, that a
job's weekly schedule specifies" using the same DST-correct `Intl`-based technique as
`window.ts`; `isJobDue` compares that single instant against `last_fired_at`, which is what
collapses any length of outage into exactly one catch-up fire. `src/lib/scheduler/store.ts`
(client-as-parameter, like `run-state.ts`) persists per-job state and provides an atomic
claim/release lock with a stale-lock override. `src/worker/scheduled-run.ts` ties it
together and is the thing systemd (or cron, or a human) actually invokes — frequently and
without needing to be precise, since the in-repo logic is authoritative.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Job-state data model | `scheduled_job` table, types, a shared store module | Migration-apply path has a known history of port-5432 issues on this dev machine (per F-01/F-03) |
| 2. Scheduler core | DST-correct due-check math + job registry, fully unit tested | Getting the DST double-offset-pass right without a real DST transition to observe live |
| 3. Orchestration entrypoint | `npm run scheduled-run` chaining collect → rank with a concurrency guard | Lock-release-scoping bug could let a stale-reclaimed slow run clobber a fresh one's state |
| 4. OS wiring & docs | Systemd unit files, deployment runbook, CLAUDE.md section | Cannot be verified against real hardware in this session — must be honestly flagged, not claimed as tested |

**Prerequisites:** F-01 (done) — needs the digest run-state module to call into for the
collection/rank actions.
**Estimated effort:** ~2 sessions across 4 phases — one schema change, one new pure-logic
module, one new entrypoint, one deployment-artifacts phase.

## Open Risks & Assumptions

- Assumes `npx supabase db push` works from this machine as it did for F-02's migration; if
  port 5432 is unreachable again, the established SQL-Editor-plus-history-insert workaround
  applies.
- The systemd artifacts are reviewed but not run — real verification is deferred until the
  operator has Pi access, and the plan tracks this explicitly rather than claiming false
  coverage.
- The 3-hour stale-lock threshold is a judgment call (generous margin over collect+rank's
  expected duration including retries); if real-world runs regularly approach it, it's a
  one-constant tuning change, not a redesign.

## Success Criteria (Summary)

- A digest that hasn't been collected this week, and whose scheduled Sunday 17:00
  Europe/Warsaw moment has passed (whether by seconds or by days), gets collected and
  ranked automatically the next time `npm run scheduled-run` executes — with no human
  action required.
- DST transitions never shift the scheduled fire time by an hour, proven by unit tests
  pinned to real transition dates.
- A crashed run's lock self-heals within hours, not permanently; a genuinely-in-progress run
  is never double-invoked.
