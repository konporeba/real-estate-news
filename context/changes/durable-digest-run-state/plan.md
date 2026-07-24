# Durable Digest Run-State & Core Schema — Implementation Plan

## Overview

Establish the durable persistence backbone that the multi-day weekly digest pipeline resumes on. This foundation creates the core `digest`/`article`/`cluster` schema, a Postgres-guarded state machine with per-stage checkpoints, deny-by-default row-level security with server-side service-role access, generated TypeScript types wired into the Supabase client, and a typed app-facing run-state module. It is the enabler contract for S-01 (collection), S-02 (ranking), and the north-star S-03 (shortlist view) — nothing in the pipeline can be built or verified until run-state is durable.

## Current State Analysis

The project is a freshly-scaffolded 10x Astro Starter (Astro 6 + React 19 + TypeScript + Supabase + Cloudflare adapter), verified building and connected to a cloud Supabase project (Postgres 17).

- **Supabase client is untyped.** `src/lib/supabase.ts:9` calls `createServerClient(SUPABASE_URL, SUPABASE_KEY, …)` with no `Database` generic. Queries return `any`. To hold the "typed" agent-friendly gate this stack was chosen for, a schema + type-generation workflow must be introduced.
- **No migrations exist.** `supabase/` contains only `config.toml` (Postgres 17); there is no `supabase/migrations/` directory. This foundation creates the first migration.
- **Auth uses only the anon/publishable key.** `src/lib/supabase.ts` reads `SUPABASE_URL` / `SUPABASE_KEY` (the publishable key) from `astro:env/server`. There is no service-role key configured — required for reading RLS-protected domain tables server-side.
- **The state machine is fully specified** (shape-notes §9): `collecting → ranking → ready_for_selection → generating → ready_for_approval → approved → published`, plus terminal `skipped` / `failed`. The design question was *where* to enforce it (resolved: Postgres guard + app orchestration).
- **The data model is sketched** (shape-notes §8, 7 entities). This foundation creates only the minimal backbone (`digest`, `article`, `cluster`); later slices own their own tables.
- **No test runner exists.** `package.json` has `dev`/`build`/`preview`/`lint`/`format` scripts but no test tooling. This plan introduces Vitest (needed by every future slice and the S-02 eval harness).

### Key Discoveries:

- Env fields are declared in `astro.config.mjs:17-22` via `envField.string({ context: "server", access: "secret", optional: true })` — the pattern to follow for `SUPABASE_SERVICE_ROLE_KEY`.
- The client factory (`src/lib/supabase.ts`) is the single wiring point for the `Database` generic; the middleware (`src/middleware.ts`) consumes it for auth only and does not touch domain tables.
- The pipeline runs as a **separate Node worker** (per `tech-stack.md`), so all run-state must live in Postgres — "survives a restart" means the worker reads the digest's current state + checkpoints on boot. There is no in-memory run state to preserve.

## Desired End State

A migration-defined `digest`/`article`/`cluster` schema exists in the Supabase project, with:
- a `digest_status` Postgres enum and a `BEFORE UPDATE` trigger that rejects any illegal status transition;
- per-stage checkpoint timestamps and a running-cost column on `digest`;
- a partial unique index guaranteeing at most one non-terminal digest per ISO week;
- RLS enabled with no anon/authenticated policies (deny-by-default), so domain rows are reachable only via the server-side service-role client;
- a generated `Database` type wired into both the existing SSR client and a new privileged service-role client;
- a typed `run-state` module exposing `createDigest`, `transitionDigest`, checkpoint helpers, and a resume-on-boot read — the contract downstream slices call.

**Verification:** `npx supabase db reset` applies the migration cleanly; `supabase gen types` regenerates `Database`; `npx astro check` and `npm run lint` pass; `npx vitest run` passes, including an integration test that inserts a digest, walks a legal transition, and asserts both an illegal transition and a duplicate-week insert are rejected at the database.

## What We're NOT Doing

- **Not creating the other four tables** (`selection`, `generated_asset`, `publication`, `feedback_label`) — later slices own them when their shape is known.
- **Not building the collection, ranking, or translation logic** — those are S-01/S-02/S-03. This foundation only provides the tables and state contract they write to.
- **Not enforcing the cost ceiling** — F-03 owns enforcement; this plan only adds the `cost_usd` column it will increment.
- **Not building the eval harness** — S-02 owns it. This plan introduces the Vitest runner but only this foundation's tests.
- **Not wiring the scheduler or worker process** — F-05 / S-01. No cron, systemd, or long-running process here.
- **Not per-user RLS policies** — single operator; auth is a PIN (F-02), not Supabase user identity.

## Implementation Approach

Follow the database-change pattern: schema/migration → typed access → app-layer module → tests. The state machine has two representations kept deliberately consistent: the **database trigger is authoritative** (illegal states are impossible even if the worker misbehaves), and a **TypeScript transition map** mirrors it for app-side guarding and UX. Server-side code reaches domain tables exclusively through a service-role client, because RLS denies the anon key by default.

## Critical Implementation Details

**State sequencing** — the transition-guard trigger must only validate when `NEW.status <> OLD.status`; no-op updates (e.g. bumping a checkpoint timestamp without a status change) must pass untouched, or every checkpoint write would trip the guard. The terminal states are `published`, `skipped`, `failed`; the partial unique index excludes exactly these so a failed week can be re-triggered. `skipped → published` is a legal transition (US-19: a missed-deadline digest stays manually publishable).

**Security** — the service-role key bypasses RLS entirely. The service-role client must be constructed only in server-only modules (reading `astro:env/server`) and must never be imported into a React island or any client-reachable path. Treat it like the highest-privilege secret on the machine.

## Phase 1: Schema & integrity migration

### Overview

Create the first Supabase migration defining the enum, the three tables, integrity constraints, the transition guard, and RLS.

### Changes Required:

#### 1. Core schema migration

**File**: `supabase/migrations/<timestamp>_digest_core_schema.sql` (new)

**Intent**: Define the durable backbone in one migration so a fresh `supabase db reset` reproduces the whole schema. Creates the status enum, the three tables in FK-safe order (enum → `digest` → `cluster` → `article`), and the running-cost + checkpoint fields on `digest`.

**Contract**:
- `digest_status` enum: `collecting`, `ranking`, `ready_for_selection`, `generating`, `ready_for_approval`, `approved`, `published`, `skipped`, `failed`.
- `digest`: `id uuid pk default gen_random_uuid()`, `window_start date not null`, `window_end date not null`, `status digest_status not null default 'collecting'`, `cost_usd numeric(10,4) not null default 0`, checkpoint columns `collection_completed_at`, `ranking_completed_at`, `translation_completed_at` (all `timestamptz null`), `last_error text null`, `created_at`/`updated_at timestamptz not null default now()`.
- `cluster`: `id uuid pk`, `digest_id uuid not null references digest(id) on delete cascade`, `relevance_score numeric(4,2) null`, `coverage_count int not null default 1`, `rank int null`, `created_at`.
- `article`: `id uuid pk`, `digest_id uuid not null references digest(id) on delete cascade`, `cluster_id uuid null references cluster(id) on delete set null`, `source_name text not null`, `source_url text not null`, `published_at timestamptz null`, `original_title text not null`, `original_lede text null`, `polish_title text null`, `polish_summary text null`, `created_at`. Add `unique(digest_id, source_url)` to prevent duplicate fetches of the same URL within a run.

#### 2. Concurrency invariant

**File**: same migration

**Intent**: Guarantee at most one active (non-terminal) digest per ISO week at the database level, so a scheduled Sunday run colliding with a manual re-trigger fails cleanly instead of double-inserting.

**Contract**: a partial unique index on the week anchor, excluding terminal states:

```sql
create unique index one_active_digest_per_week
  on digest (window_start)
  where status not in ('published', 'skipped', 'failed');
```

#### 3. Transition-guard trigger

**File**: same migration

**Intent**: Make illegal status transitions impossible at the data layer. A `BEFORE UPDATE` trigger validates `OLD.status → NEW.status` against the allowed map and raises on violation; it must skip validation when the status is unchanged.

**Contract**: a `plpgsql` function + `BEFORE UPDATE ON digest` trigger. Allowed transitions:

```
collecting          → ranking | failed
ranking             → ready_for_selection | failed
ready_for_selection → generating | skipped | failed
generating          → ready_for_approval | failed
ready_for_approval  → approved | skipped | failed
approved            → published | skipped | failed
skipped             → published            -- US-19 manual publish later
failed              → collecting           -- FR-018 re-trigger in place
published           → (none, terminal)
```

The function returns early (`NEW`) when `NEW.status = OLD.status`; otherwise it raises `exception` with a clear message when the pair is not in the map. Also add a second `BEFORE UPDATE` trigger (or fold into the same function) that sets `NEW.updated_at = now()`.

#### 4. Row-level security

**File**: same migration

**Intent**: Deny-by-default access to all three domain tables so they are unreachable via the anon/publishable key or PostgREST; server-side code uses the service-role client (Phase 2), which bypasses RLS.

**Contract**: `alter table digest enable row level security;` (and `article`, `cluster`). Deliberately create **no** policies — with RLS enabled and no policies, anon and authenticated roles are denied all access. Add a SQL comment documenting that this is intentional and that access is service-role-only.

### Success Criteria:

#### Automated Verification:

- [ ] Migration applies cleanly to a fresh local DB: `npx supabase db reset`
- [ ] All three tables, the enum, the partial unique index, and both triggers exist (inspect via `npx supabase db reset` output / `psql \d digest`)
- [ ] No SQL lint/parse errors during apply

#### Manual Verification:

- [ ] Schema is visible and correct in Supabase Studio (local, `http://localhost:54323`)
- [ ] A `select` on `digest` using the anon/publishable key returns zero rows / permission denied (RLS deny-by-default confirmed)
- [ ] The FK cascade behaves: deleting a `digest` removes its `article`/`cluster` rows

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Typed access & service-role client

### Overview

Generate the `Database` type from the new schema, wire it into the existing SSR client, and add a privileged server-side service-role client for domain-table access.

### Changes Required:

#### 1. Generated database types

**File**: `src/db/database.types.ts` (new, generated)

**Intent**: Produce the `Database` type so all Supabase queries are typed end-to-end.

**Contract**: output of `npx supabase gen types typescript --local > src/db/database.types.ts` (or `--project-id arugswrcmlupwyyumugn` against the cloud project). Exports a `Database` type. This file is regenerated, not hand-edited; note that in a header comment.

#### 2. Env schema for the service-role key

**File**: `astro.config.mjs`

**Intent**: Declare `SUPABASE_SERVICE_ROLE_KEY` as a server-only secret alongside the existing Supabase env fields.

**Contract**: add `SUPABASE_SERVICE_ROLE_KEY: envField.string({ context: "server", access: "secret", optional: true })` to the `env.schema` block (mirrors lines 19-20).

#### 3. Env files

**Files**: `.env`, `.dev.vars` (both git-ignored)

**Intent**: Add a placeholder for the service-role key for the operator to fill from the Supabase dashboard (Settings → API → `service_role`).

**Contract**: append `SUPABASE_SERVICE_ROLE_KEY=` to both files. Document in the plan hand-off that the real value must be pasted before server-side domain reads work.

#### 4. Wire the typed SSR client

**File**: `src/lib/supabase.ts`

**Intent**: Parameterize the existing `createServerClient` call with the generated `Database` type so session/auth code stays typed.

**Contract**: `createServerClient<Database>(SUPABASE_URL, SUPABASE_KEY, …)`; import `Database` from `@/db/database.types`. No behavioral change.

#### 5. Service-role client

**File**: `src/lib/supabase-admin.ts` (new)

**Intent**: Provide the single, server-only factory for privileged domain-table access that bypasses RLS. Every server-side read/write of `digest`/`article`/`cluster` goes through this.

**Contract**: export `createServiceClient()` using `createClient<Database>` from `@supabase/supabase-js` (not `@supabase/ssr`), reading `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `astro:env/server`, configured with `auth: { persistSession: false, autoRefreshToken: false }`. Return `null` (matching `src/lib/supabase.ts`'s pattern) when the key is absent. Add a top-of-file comment: server-only, never import from a client island.

### Success Criteria:

#### Automated Verification:

- [ ] Type generation succeeds and writes `src/db/database.types.ts` exporting `Database`
- [ ] Type checking passes with the generic wired: `npx astro check`
- [ ] Linting passes: `npm run lint`
- [ ] Production build succeeds: `npm run build`

#### Manual Verification:

- [ ] With a real `service_role` key set, a server-side `createServiceClient().from('digest').select()` succeeds
- [ ] The same query via the anon client (`src/lib/supabase.ts`) returns no rows / denied (RLS boundary confirmed end-to-end)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Run-state orchestration module

### Overview

Introduce the Vitest runner and a typed run-state module that downstream slices call to create digests, transition them, checkpoint stages, and resume on boot.

### Changes Required:

#### 1. Test runner

**Files**: `vitest.config.ts` (new), `package.json`

**Intent**: Add Vitest as the project's test runner (needed here and by every future slice / the S-02 eval harness).

**Contract**: install `vitest` as a dev dependency; add a `"test": "vitest run"` script; minimal `vitest.config.ts`. No coverage tooling yet.

#### 2. State-machine module

**File**: `src/lib/digest/state-machine.ts` (new)

**Intent**: Mirror the database's authoritative transition map in TypeScript for app-side guarding and UX, and expose the status type from the generated enum.

**Contract**: export `DigestStatus` (derived from `Database['public']['Enums']['digest_status']`), a `TRANSITIONS: Record<DigestStatus, DigestStatus[]>` map identical to the trigger's, `TERMINAL_STATES`, and `canTransition(from, to): boolean`. The DB trigger remains authoritative; this is the app-side twin.

#### 3. Run-state helpers

**File**: `src/lib/digest/run-state.ts` (new)

**Intent**: The app-facing contract downstream slices use. Wraps the service-role client with typed operations over the digest lifecycle.

**Contract**:
- `createDigest(window: { start: string; end: string })` — inserts a `collecting` digest; on the partial-unique-index violation returns a typed `{ ok: false, reason: 'active_digest_exists' }` rather than throwing.
- `transitionDigest(id, to: DigestStatus)` — updates status; surfaces the DB guard's rejection as a typed error result.
- `markStageComplete(id, stage)` — sets the matching `*_completed_at` checkpoint timestamp.
- `getActiveDigestForWeek(window)` and `resumeDigest(id)` — read the current state + checkpoints for worker boot.

All functions obtain their client via `createServiceClient()` and are server-only.

#### 4. Tests

**Files**: `src/lib/digest/state-machine.test.ts` (new), `src/lib/digest/run-state.test.ts` (new)

**Intent**: Prove the transition map and the run-state contract, including the DB-level guarantees.

**Contract**:
- Unit: `canTransition` accepts every legal pair and rejects illegal ones; `TERMINAL_STATES` correctness; `TRANSITIONS` matches the migration's map (guards against drift).
- Integration (against local Supabase): `createDigest` succeeds once and returns `active_digest_exists` on a second same-week insert (partial unique index); a legal transition persists; an illegal transition (`collecting → published`) is rejected by the DB; `markStageComplete` sets the timestamp without tripping the guard; `resumeDigest` returns the persisted state.

### Success Criteria:

#### Automated Verification:

- [ ] Vitest runs: `npx vitest run`
- [ ] State-machine unit tests pass (legal/illegal transitions, terminal set, map-vs-migration parity)
- [ ] Run-state integration tests pass against a local DB (create-collision, legal transition persists, illegal transition rejected, checkpoint write, resume)
- [ ] Type checking passes: `npx astro check`
- [ ] Linting passes: `npm run lint`

#### Manual Verification:

- [ ] Simulated restart: after transitioning a digest to `ranking` and setting `collection_completed_at`, `resumeDigest` returns state `ranking` with the checkpoint set — confirming the worker could resume from Postgres alone
- [ ] The TypeScript `TRANSITIONS` map and the SQL trigger agree (no drift) on a manual spot-check of two transitions

**Implementation Note**: After completing this phase and all automated verification passes, pause for final manual confirmation.

---

## Testing Strategy

### Unit Tests:

- Transition map correctness (`canTransition` for all legal/illegal pairs)
- Terminal-state detection
- Drift guard: TS `TRANSITIONS` equals the migration's allowed map

### Integration Tests (local Supabase):

- Create-then-collide on the same week → `active_digest_exists`
- Legal transition persists; illegal transition rejected by the DB trigger
- Checkpoint write on an unchanged status does not trip the guard
- FK cascade delete
- RLS: anon client sees nothing; service client sees rows

### Manual Testing Steps:

1. `npx supabase db reset`, open Studio, confirm the schema and inspect the trigger/index.
2. With the anon key, attempt to read `digest` → expect empty/denied.
3. With a real `service_role` key, read `digest` server-side → expect success.
4. Insert a digest, advance it a stage, set a checkpoint, then read it back via `resumeDigest` to confirm restart-resume works from Postgres alone.

## Performance Considerations

Not a hotspot — a single weekly digest with a small article pool on a Raspberry Pi. Indexes are for correctness (the partial unique index), not throughput. No concern at this scale.

## Migration Notes

First migration in the project; no existing data to migrate. Apply to the cloud project with `npx supabase db push` (or link + push) once verified locally. Re-running type generation after any future migration is a required manual step — note it in the run-state module header.

## References

- Roadmap item: `context/foundation/roadmap.md` → F-01
- Data model sketch: `context/foundation/shape-notes.md` §8; state machine §9
- Env-field pattern: `astro.config.mjs:17-22`
- Client wiring point: `src/lib/supabase.ts:5-24`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema & integrity migration

#### Automated

- [x] 1.1 Migration applies cleanly to a fresh local DB: `npx supabase db reset` — 00280d7
- [x] 1.2 Enum, three tables, partial unique index, and both triggers exist — 00280d7
- [x] 1.3 No SQL lint/parse errors during apply — 00280d7

#### Manual

- [x] 1.4 Schema visible and correct in Supabase Studio — 00280d7
- [x] 1.5 Anon/publishable key read of `digest` returns zero rows / denied (RLS) — 00280d7
- [x] 1.6 FK cascade removes child `article`/`cluster` rows on digest delete — deferred to Phase 3 (integration test 3.3) — 00280d7

### Phase 2: Typed access & service-role client

#### Automated

- [x] 2.1 Type generation writes `src/db/database.types.ts` exporting `Database`
- [x] 2.2 Type checking passes: `npx astro check`
- [x] 2.3 Linting passes: `npm run lint`
- [x] 2.4 Production build succeeds: `npm run build`

#### Manual

- [x] 2.5 Server-side service client reads `digest` successfully (with real key)
- [x] 2.6 Anon client read of the same table is denied (RLS boundary end-to-end)

### Phase 3: Run-state orchestration module

#### Automated

- [ ] 3.1 Vitest runs: `npx vitest run`
- [ ] 3.2 State-machine unit tests pass (transitions, terminal set, map-vs-migration parity)
- [ ] 3.3 Run-state integration tests pass (collision, transition persist/reject, checkpoint, resume)
- [ ] 3.4 Type checking passes: `npx astro check`
- [ ] 3.5 Linting passes: `npm run lint`

#### Manual

- [ ] 3.6 Simulated restart: `resumeDigest` returns persisted state + checkpoint after transition
- [ ] 3.7 TS `TRANSITIONS` map and SQL trigger agree on a spot-check
