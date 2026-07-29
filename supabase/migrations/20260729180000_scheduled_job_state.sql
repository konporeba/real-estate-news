-- F-05: Reliable scheduler backbone — job-state data model
--
-- Persists per-job scheduling state so a worker invocation can tell, across separate
-- process runs, whether a named job (e.g. "collection") is currently in progress and when
-- it last fired/completed. There is deliberately no "next due" column: due-ness is always
-- derived from the job's schedule spec (defined in code, src/lib/scheduler/registry.ts)
-- plus this row's last_fired_at, so there is nothing that can drift out of sync.
--
-- No seed row is inserted here — src/lib/scheduler/store.ts's tryAcquireJob() upserts a
-- row for a job name on its first invocation, so a future job (S-08's "publish") never
-- needs a migration of its own.

-- ---------------------------------------------------------------------------
-- 1. Status enum
-- ---------------------------------------------------------------------------
create type scheduled_job_status as enum ('idle', 'running');

-- ---------------------------------------------------------------------------
-- 2. scheduled_job
-- ---------------------------------------------------------------------------
create table scheduled_job (
  name               text primary key,
  status             scheduled_job_status not null default 'idle',
  started_at         timestamptz,
  last_fired_at      timestamptz,
  last_completed_at  timestamptz,
  last_error         text,
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. updated_at maintenance — reuses the trigger function set_updated_at()
-- defined by the F-01 migration (20260722173032_digest_core_schema.sql).
-- ---------------------------------------------------------------------------
create trigger scheduled_job_set_updated_at
  before update on scheduled_job
  for each row
  execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Row-level security: deny-by-default
-- ---------------------------------------------------------------------------
-- Same posture as digest/cluster/article: RLS enabled with no policies, so only the
-- service-role client (server-side, bypasses RLS) can reach this table.
alter table scheduled_job enable row level security;

-- ---------------------------------------------------------------------------
-- 5. Atomic claim — PostgREST cannot express "insert, or update only if idle /
-- stale" as a single conditional upsert, so this is a function, mirroring the
-- increment_digest_cost precedent (20260724170000_digest_cost_increment.sql).
-- ---------------------------------------------------------------------------
-- Claims scheduled_job by name: inserts a fresh 'running' row if none exists, or
-- atomically flips an existing row to 'running' only if it is currently 'idle' or has
-- been 'running' for longer than p_stale_after_seconds (a crashed prior invocation).
-- Returns the claimed row as a one-row set, or an empty set if a genuinely active run
-- already holds it.
--
-- SETOF, not a bare row: a scalar-composite return serializes a "no row" result as an
-- object with every field null (Postgres/PostgREST's NULL-composite representation),
-- which is indistinguishable from a real row at the JSON layer. SETOF instead serializes
-- "no row" as an empty array, which the caller can check with a plain length test.
create or replace function public.claim_scheduled_job(p_name text, p_now timestamptz, p_stale_after_seconds int)
  returns setof scheduled_job
  language sql
  security definer
  set search_path = public
as $$
  insert into scheduled_job (name, status, started_at)
  values (p_name, 'running', p_now)
  on conflict (name) do update
    set status = 'running', started_at = p_now
    where scheduled_job.status = 'idle'
       or (scheduled_job.status = 'running'
           and scheduled_job.started_at < p_now - make_interval(secs => p_stale_after_seconds))
  returning scheduled_job.*;
$$;

comment on function public.claim_scheduled_job(text, timestamptz, int) is
  'F-05: atomically claim a scheduled_job row for running, or return an empty set if another invocation genuinely holds it.';

-- Same trust boundary as increment_digest_cost: SECURITY DEFINER must not become a way
-- around scheduled_job's deny-by-default RLS, so execute is service-role only.
revoke execute on function public.claim_scheduled_job(text, timestamptz, int) from public;
revoke execute on function public.claim_scheduled_job(text, timestamptz, int) from anon;
revoke execute on function public.claim_scheduled_job(text, timestamptz, int) from authenticated;
grant execute on function public.claim_scheduled_job(text, timestamptz, int) to service_role;
