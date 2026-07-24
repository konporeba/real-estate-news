# Durable Digest Run-State & Core Schema — Plan Brief

> Full plan: `context/changes/durable-digest-run-state/plan.md`

## What & Why

Build the durable persistence backbone the multi-day weekly digest pipeline resumes on. A run spans Sunday→Tuesday and must survive a machine restart, so all run-state lives in Postgres, not memory. This foundation (roadmap F-01) unblocks collection (S-01), ranking (S-02), and the north-star shortlist view (S-03) — nothing in the pipeline can be built until run-state is durable and correct.

## Starting Point

A freshly-scaffolded 10x Astro Starter connected to a cloud Supabase project (Postgres 17). The Supabase client is currently untyped, there are no migrations, only the anon/publishable key is configured, and there is no test runner. The digest state machine and data model are fully specified in the shape-notes but not yet implemented.

## Desired End State

The Supabase project has a migration-defined `digest`/`article`/`cluster` schema with a Postgres-enforced state machine (illegal transitions rejected at the data layer), per-stage checkpoints, a running-cost field, a one-active-digest-per-week guarantee, and deny-by-default RLS. A generated `Database` type flows into both the SSR client and a new server-only service-role client, and a typed `run-state` module lets any downstream slice create, transition, checkpoint, and resume a digest.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Schema/type tooling | Supabase CLI migrations + `gen types` | Postgres stays the single source of truth; zero new deps; holds the "typed" gate | Plan |
| State-machine enforcement | Hybrid: Postgres guard trigger + app orchestration | Illegal states impossible even if the worker has a bug | Plan |
| Schema scope | Minimal backbone (digest/article/cluster) | Matches roadmap progressive-disclosure; later slices own their tables | Roadmap + Plan |
| Resumability | Per-stage checkpoints | Resume-from-stage fits a weekly cadence without per-item bookkeeping | Plan |
| Concurrency | Partial unique index per ISO week | Hard DB guarantee against duplicate weekly runs | Plan |
| Table security | RLS on, deny-by-default, service-role server access | Domain data unreachable via the anon key; private-path + PIN stays the gate | Plan |
| Cost tracking | Single running-cost column now | The field F-03's ceiling reads; matches the data-model sketch | Plan |
| Verification | Apply + type-gen + transition round-trip (Vitest) | Proves the guard and typed access actually work, not just that SQL parses | Plan |

## Scope

**In scope:** the three core tables; `digest_status` enum + transition-guard trigger; per-stage checkpoint + cost columns; partial unique index; deny-by-default RLS; generated types + typed SSR client; server-only service-role client + env wiring; typed run-state module; Vitest + this foundation's tests.

**Out of scope:** the other four tables; collection/ranking/translation logic; cost-ceiling enforcement (F-03); the eval harness (S-02); scheduler/worker process (F-05/S-01); per-user RLS.

## Architecture / Approach

Database-change pattern: schema/migration → typed access → app module → tests. The **DB trigger is authoritative** for legal transitions; a TypeScript transition map mirrors it for app-side guarding. All server-side domain-table access flows through a **service-role client** (the anon key is denied by RLS). The digest row is the single durable record a restarted worker reads to resume.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema & integrity migration | Enum, 3 tables, guard trigger, unique index, RLS | Getting the transition map + no-op-update exemption right |
| 2. Typed access & service-role client | Generated `Database` type, typed clients, service-role key wiring | Introduces a highly-privileged key to store carefully |
| 3. Run-state orchestration module | Vitest + typed create/transition/checkpoint/resume API | Keeping the TS transition map in sync with the SQL trigger |

**Prerequisites:** the round-trip/integration tests need a running Postgres — local Supabase (**Docker**) or a shadow/test DB; the operator must paste a real `service_role` key into `.env`/`.dev.vars` for the Phase 2/3 manual checks.
**Estimated effort:** ~2–3 focused sessions across the three phases.

## Open Risks & Assumptions

- **Docker for local Supabase is unconfirmed on this machine.** Phases 1 & 3 automated verification assume `npx supabase db reset` works locally; fallback is a dedicated shadow/test database or a throwaway cloud test project.
- **Service-role key handling.** A second, RLS-bypassing key now lives on the home machine — it must never reach a client bundle; the service client is server-only by construction.
- **Transition-map drift.** The SQL trigger and TS map are two representations of one contract; a parity unit test guards against divergence.

## Success Criteria (Summary)

- A fresh `npx supabase db reset` reproduces the whole schema; the guard rejects an illegal transition and the index rejects a duplicate-week insert.
- `Database` types are generated and both clients are typed; `astro check`, `lint`, and `build` pass.
- A digest can be created, advanced, checkpointed, and read back via `resumeDigest` — proving a restarted worker can resume from Postgres alone.
