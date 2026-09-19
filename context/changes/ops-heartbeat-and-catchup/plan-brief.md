# Ops Heartbeat & Catch-up — Plan Brief

> Full plan: `context/changes/ops-heartbeat-and-catchup/plan.md`

## What & Why

Close out S-10, the last unshipped roadmap slice: add a heartbeat ping to an external dead-man's-switch
(healthchecks.io) so the operator learns when the home server or scheduler has gone silent, instead
of mistaking silence for "no news" (FR-028). The other half of S-10, missed-run catch-up (FR-027),
turns out to already be built — this plan proves it rather than reimplementing it.

## Starting Point

`src/worker/scheduled-run.ts` already runs every 15 minutes via a systemd timer, checking every job
in `SCHEDULED_JOBS` for due-ness and safely replaying a window missed while the Pi was off — this is
F-05's generic `isJobDue` mechanism, already proven correct across DST boundaries and multi-week
outages. Nothing in the codebase pings any external monitor today.

## Desired End State

Every ~15-minute tick ends with a ping to the operator's healthchecks.io check: success URL when
every due job succeeded, the `/fail`-suffixed URL when any job errored. If the Pi goes offline or
the scheduler stalls, the ping stops arriving and healthchecks.io alerts after its configured grace
period. A missing config value never breaks anything — the worker runs exactly as it does today.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|---|---|---|---|
| Monitor service | healthchecks.io | Free tier, simple GET-based ping URL, built-in `/fail` signal, no SDK — fits this project's minimal-dependency style. | Plan |
| Ping trigger | Every scheduled-run tick (~15 min) | Proves the machine AND the scheduler loop are alive, not just that a weekly job happened to fire. | Plan |
| Ping timing | After the tick completes | Simplest single call site; proves the whole cycle finished. | Plan |
| Failure signaling | Yes — `/fail` URL when any job errored | Distinguishes "Pi is off" (no ping at all) from "Pi is fine but a job broke" (immediate distinct alert), at zero extra code cost. | Plan |
| Heartbeat-send failure impact | Never affects scheduled-run's own exit code | Matches `sendEmail`'s never-throw contract — a notification side-channel must not block the pipeline work it reports on. | Plan |
| FR-027 catch-up scope | Verify only, no new production code | F-05's `isJobDue` already covers every registered job generically; this plan adds proof, not reimplementation. | Plan |
| Deploy docs | Extend the existing `deploy/systemd/README.md` | Keeps one canonical deploy doc instead of scattering Pi setup steps. | Plan |

## Scope

**In scope:**
- `sendHeartbeat()` module (fetch-based, never throws, typed result) + unit tests + opt-in live smoke test
- `HEARTBEAT_PING_URL` env var + `reportHeartbeat()` wrapper wired into `scheduled-run.ts`'s `main()`
- A registry-wide catch-up test proving FR-027 against the real job list
- `.env.example`, `deploy/systemd/README.md`, `CLAUDE.md`, and roadmap S-10 close-out

**Out of scope:**
- A vendor-agnostic heartbeat abstraction (healthchecks.io's URL convention is hardcoded)
- Error detail in the ping body (pass/fail signal only)
- Retry logic on a failed ping (next tick is the natural retry)
- A new `npm run heartbeat` CLI entrypoint
- Real Pi hardware verification (no Linux/systemd host in this dev environment — same limitation F-05's own runbook already carries)

## Architecture / Approach

A single new module (`src/lib/heartbeat/send.ts`) with no client-construction step — the ping URL
is the only credential, so it's read straight from worker env and passed into `sendHeartbeat()`.
`scheduled-run.ts`'s `main()` calls a thin wrapper, `reportHeartbeat()`, once per tick after job
execution — mirroring `rank.ts`'s `notifyDigestReady()` pattern of a directly-unit-testable,
never-throwing side effect composed at the entrypoint.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. Heartbeat send module | `sendHeartbeat()` + types + unit/live tests | None significant — small, isolated module |
| 2. Wire into scheduled-run.ts | Env var, `reportHeartbeat()`, call site, unit tests | Must not let heartbeat failure affect the real exit code |
| 3. Catch-up verification | Registry-wide test proving FR-027 | Must use synthetic job names — real names would corrupt production scheduler state in a shared test DB |
| 4. Docs & deploy runbook | `.env.example`, systemd README, CLAUDE.md, roadmap close-out | None significant |
| 5. End-to-end verification | Full suite + live smoke + manual checks | Real Pi deployment can't be verified from this dev environment |

**Prerequisites:** F-05 (shipped). Operator needs a healthchecks.io account for Phase 5's live verification.
**Estimated effort:** ~1 session across 5 phases — small, self-contained feature with no schema changes.

## Open Risks & Assumptions

- Assumes healthchecks.io's ping API contract (GET/POST accepted, `/fail` suffix, 2xx on success)
  remains stable — well-established and unlikely to change, but not independently re-verified here.
- The real Pi deployment step is carried forward unverified, consistent with how S-08's live dry
  run against real Meta/LinkedIn accounts was also carried forward.

## Success Criteria (Summary)

- The operator can see, on the healthchecks.io dashboard, regular pings roughly every 15 minutes.
- If the Pi is powered off, the operator gets an alert instead of silence.
- A job failure (not just total silence) triggers a distinct alert via the `/fail` ping.
