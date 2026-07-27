-- F-02: Lockout & rate-limit data model for the operator PIN access gate.
--
-- A singleton table (exactly one row, enforced by a boolean primary key that can only be
-- `true`) tracks the failed-attempt count and an optional lockout expiry for the single
-- operator's PIN. One SECURITY DEFINER RPC does the entire "is this locked / record this
-- attempt" step as a single UPDATE ... RETURNING, following the increment_digest_cost /
-- assign_articles_to_clusters precedent -- the F-03 cost-ceiling race (check and increment
-- as two round trips going soft under concurrency) is exactly the class of bug this avoids.
--
-- No app code calls this yet (Phase 3 wires it in) -- this migration is fully self-contained
-- and verifiable via direct RPC calls from the SQL editor.

-- ---------------------------------------------------------------------------
-- 1. pin_lockout_state (singleton: id can only ever be `true`)
-- ---------------------------------------------------------------------------
create table pin_lockout_state (
  id              boolean primary key default true,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now(),
  constraint pin_lockout_state_singleton check (id)
);

insert into pin_lockout_state (id) values (true);

create trigger pin_lockout_state_set_updated_at
  before update on pin_lockout_state
  for each row
  execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. record_pin_attempt: atomic check-and-record
-- ---------------------------------------------------------------------------
-- Semantics (see plan for the full contract):
--   * p_matched=true  -> always authenticates, resets failed_attempts to 0, clears lockout,
--                        even mid-lockout (a correct PIN already proves the secret is known).
--   * p_matched=false and currently locked -> counter/lockout left unchanged (no extension
--                        from continued probing during an active lockout).
--   * p_matched=false and not locked -> failed_attempts += 1; lockout set once the new count
--                        reaches p_max_attempts.
-- `authenticated` in the result is simply p_matched -- a failed match is never authenticated
-- regardless of lockout state, so no separate expression is needed.
create or replace function public.record_pin_attempt(
  p_matched boolean,
  p_max_attempts int,
  p_lockout_seconds int
)
  returns table(authenticated boolean, locked_until timestamptz)
  language sql
  security definer
  set search_path = public
as $$
  update pin_lockout_state
     set failed_attempts =
           case
             when p_matched then 0
             when pin_lockout_state.locked_until is not null
                  and pin_lockout_state.locked_until > now()
               then pin_lockout_state.failed_attempts
             else pin_lockout_state.failed_attempts + 1
           end,
         locked_until =
           case
             when p_matched then null
             when pin_lockout_state.locked_until is not null
                  and pin_lockout_state.locked_until > now()
               then pin_lockout_state.locked_until
             when pin_lockout_state.failed_attempts + 1 >= p_max_attempts
               then now() + make_interval(secs => p_lockout_seconds)
             else pin_lockout_state.locked_until
           end
   where id = true
  returning p_matched, pin_lockout_state.locked_until;
$$;

comment on function public.record_pin_attempt(boolean, int, int) is
  'F-02: atomically check-and-record one PIN attempt against the singleton lockout row. Returns whether this attempt authenticates and the resulting lockout expiry (null if not locked).';

-- Same trust boundary as increment_digest_cost / assign_articles_to_clusters: the table is
-- RLS-enabled deny-by-default, and a SECURITY DEFINER function must not become a way around
-- that. Execute is service-role only.
revoke execute on function public.record_pin_attempt(boolean, int, int) from public;
revoke execute on function public.record_pin_attempt(boolean, int, int) from anon;
revoke execute on function public.record_pin_attempt(boolean, int, int) from authenticated;
grant execute on function public.record_pin_attempt(boolean, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Row-level security: deny-by-default
-- ---------------------------------------------------------------------------
-- RLS enabled with NO policies -- the anon/authenticated roles have no direct access. The
-- only way to reach this table is via record_pin_attempt (service-role execute only), so the
-- lockout state cannot be read or forged through PostgREST regardless of key exposure.
alter table pin_lockout_state enable row level security;
