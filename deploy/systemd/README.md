# Scheduler backbone — systemd deployment (F-05)

> **Status: reviewed, not verified against real hardware.** These unit files were written
> and read through carefully for syntax and correctness, but this development environment
> has no Linux/systemd host to actually run them on. Treat the steps below as the intended
> procedure, and confirm each one against the real Raspberry Pi before trusting it in
> production.

## What this is

`real-estate-news-scheduled-run.timer` fires `real-estate-news-scheduled-run.service`
every 15 minutes. The service runs `npm run scheduled-run`
(`src/worker/scheduled-run.ts`), which checks every job in the registry
(`src/lib/scheduler/registry.ts`) for due-ness and runs whichever are due. The timer is
deliberately frequent and deliberately dumb — DST-correctness, catch-up after an outage,
and concurrency-safety all live in the in-repo due-check, not in the timer's own timing
(see `context/changes/reliable-scheduler-backbone/plan.md`'s Implementation Approach).
`Persistent=true` is a backstop for an outage long enough to miss the 15-minute cadence
itself; systemd fires once on boot in that case, and the in-repo check decides whether
that catch-up fire needs to do anything.

## Install

1. Clone/deploy the repo to its real path on the Pi (adjust `WorkingDirectory` and
   `EnvironmentFile` in `real-estate-news-scheduled-run.service` if it differs from
   `/opt/real-estate-news`).
2. Confirm `.env` exists at that path with the same variables `npm run collect`/`npm run
   rank` already require (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ANTHROPIC_API_KEY`, etc. — see `src/worker/env.ts`).
3. Copy both unit files into systemd's search path:
   ```bash
   sudo cp deploy/systemd/real-estate-news-scheduled-run.service /etc/systemd/system/
   sudo cp deploy/systemd/real-estate-news-scheduled-run.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   ```
4. Enable and start the timer (not the service directly — the service is `Type=oneshot`
   and is meant to be triggered by the timer):
   ```bash
   sudo systemctl enable --now real-estate-news-scheduled-run.timer
   ```

## Verify

- Confirm the timer is registered and see its next scheduled fire:
  ```bash
  systemctl list-timers real-estate-news-scheduled-run.timer
  ```
- Trigger the service once by hand, without waiting for the timer, to confirm the unit
  itself is wired correctly:
  ```bash
  sudo systemctl start real-estate-news-scheduled-run.service
  ```
- Read what happened:
  ```bash
  journalctl -u real-estate-news-scheduled-run.service -n 50 --no-pager
  ```
  A healthy run logs one `[scheduled-run] <job>: not due` or
  `[scheduled-run] <job>: due, claimed — running` line per registered job (currently just
  `collection`).

## Troubleshooting

- **Timer shows no next-fire time** — check `systemctl status
  real-estate-news-scheduled-run.timer` for a unit-load error; re-run `daemon-reload`
  after any edit to the `.timer`/`.service` files.
- **Service fails immediately** — `journalctl -u real-estate-news-scheduled-run.service`
  will show the same startup error `npm run collect`/`npm run rank` would (e.g. a missing
  `.env` variable, per `src/worker/env.ts`'s validation).
- **A job never seems to fire** — query `scheduled_job` directly (via the Supabase
  dashboard or `psql`) for the job's `status`/`last_fired_at`/`last_completed_at`/
  `last_error`; a `status` stuck on `running` past the 3-hour stale threshold
  (`DEFAULT_STALE_AFTER_MS` in `src/lib/scheduler/store.ts`) indicates a crashed prior run
  that the next tick will safely reclaim.
