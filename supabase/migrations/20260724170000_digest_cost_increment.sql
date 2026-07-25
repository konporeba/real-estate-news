-- F-03: Atomic cost accumulation for the LLM cost-ceiling harness.
--
-- The harness accumulates spend against digest.cost_usd from every model call. Under any
-- concurrency (S-02 scores ~234 articles) a read-modify-write in application code would lose
-- increments, and PostgREST cannot express `cost_usd = cost_usd + $delta`. This function is the
-- atomic increment, returning the post-increment total so the caller's ceiling check and the
-- accumulation are one round trip.
--
-- No schema change: digest.cost_usd already exists (numeric(10,4), from F-01). This adds only the
-- function. Note the numeric(10,4) precision floor: a delta below $0.00005 rounds to zero on store
-- -- real Sonnet calls sit well above it, but the column is not exact by design.

create or replace function public.increment_digest_cost(p_digest_id uuid, p_delta numeric)
  returns numeric
  language sql
  security definer
  set search_path = public
as $$
  update digest
     set cost_usd = cost_usd + p_delta
   where id = p_digest_id
  returning cost_usd;
$$;

comment on function public.increment_digest_cost(uuid, numeric) is
  'F-03: atomically add p_delta USD to a digest''s cost_usd and return the new total. Returns null when the digest id does not exist.';

-- digest is RLS-enabled deny-by-default; a SECURITY DEFINER function must not become a way around
-- that. Execute is service-role only -- the same trust boundary every run-state write already uses.
revoke execute on function public.increment_digest_cost(uuid, numeric) from public;
revoke execute on function public.increment_digest_cost(uuid, numeric) from anon;
revoke execute on function public.increment_digest_cost(uuid, numeric) from authenticated;
grant execute on function public.increment_digest_cost(uuid, numeric) to service_role;
