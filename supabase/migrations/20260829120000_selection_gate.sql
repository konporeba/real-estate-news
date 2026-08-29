-- S-04: Story selection gate (human gate 1).
--
-- The tables F-01's core schema deliberately deferred ("Later slices own selection /
-- generated_asset / publication / feedback_label; those are deliberately NOT created here"),
-- plus the single function that performs the whole gate atomically:
--   * selection_format / selection_platform enums (FR-012's vocabulary)
--   * selection       -- one row per confirmed digest: the format and platforms
--   * selection_item  -- one row per SHORTLISTED cluster, flagged picked or passed
--   * confirm_selection(...) -- validate + write both tables + transition, in one transaction
--   * RLS enabled deny-by-default on both tables (service-role access only)
--
-- Why passes are stored, not just picks: US-10 requires that a shortlist of 15 from which 3
-- were chosen yields 3 picks AND 12 passes as labeled examples. S-09 (archive-and-learning-loop)
-- consumes them as few-shot material to converge the ranking rubric on the operator's real
-- editorial taste. Storing only the picks would discard half the training signal, so
-- `selection_item` covers the whole shortlist and `picked` is the label.

-- ---------------------------------------------------------------------------
-- 1. Selection vocabulary (FR-012)
-- ---------------------------------------------------------------------------
create type selection_format as enum ('single_post', 'carousel');
create type selection_platform as enum ('instagram', 'linkedin', 'facebook');

-- ---------------------------------------------------------------------------
-- 2. selection (one confirmed selection per digest)
-- ---------------------------------------------------------------------------
-- `digest_id` is UNIQUE, which is what makes double-confirm impossible independently of the
-- digest state machine: even if the transition guard were bypassed, a second confirm collides
-- here. Rows are immutable once written (no updated_at trigger) -- the gate has no undo, so a
-- confirmed selection is a historical record, not mutable state.
create table selection (
  id           uuid primary key default gen_random_uuid(),
  digest_id    uuid not null unique references digest (id) on delete cascade,
  format       selection_format not null,
  platforms    selection_platform[] not null,
  confirmed_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  -- cardinality(), not array_length(..., 1): the latter returns NULL for an empty array, and a
  -- NULL check expression passes rather than fails, so `array_length(platforms, 1) >= 1` would
  -- silently admit '{}'.
  constraint selection_platforms_not_empty check (cardinality(platforms) >= 1)
);

comment on table selection is
  'S-04: the operator''s confirmed choice for one digest -- output format and target platforms (FR-012). One row per digest, enforced by the unique constraint on digest_id.';

-- ---------------------------------------------------------------------------
-- 3. selection_item (the labeled example set -- picks AND passes)
-- ---------------------------------------------------------------------------
create table selection_item (
  id           uuid primary key default gen_random_uuid(),
  selection_id uuid not null references selection (id) on delete cascade,
  cluster_id   uuid not null references cluster (id) on delete cascade,
  picked       boolean not null,
  created_at   timestamptz not null default now(),
  unique (selection_id, cluster_id)
);

create index selection_item_selection_id_idx on selection_item (selection_id);

comment on table selection_item is
  'S-04/US-10: one row per SHORTLISTED cluster, not per pick. `picked` is the label -- true for the 2-4 chosen, false for the rest. S-09 reads this as few-shot material for the ranking rubric, so the passes are as load-bearing as the picks.';

-- ---------------------------------------------------------------------------
-- 4. confirm_selection: the whole gate, atomically
-- ---------------------------------------------------------------------------
-- Follows the "PostgREST can't express it, so make it a function" precedent set by
-- increment_digest_cost (F-03), assign_articles_to_clusters / persist_cluster_rankings (S-02),
-- record_pin_attempt (F-02) and claim_scheduled_job (F-05). Here the reason is atomicity rather
-- than round trips: confirming spans an insert into `selection`, N inserts into `selection_item`,
-- and a status transition on `digest`. Split across three PostgREST calls, a failure between
-- them leaves a confirmed selection attached to a digest still in `ready_for_selection` -- an
-- inconsistent state with no owner. As one function it is one transaction: all of it, or none.
--
-- The caller passes the shortlist explicitly rather than letting this function re-derive it from
-- `cluster.rank`. That is deliberate: what the operator actually saw on the page is what gets
-- labeled, so a re-rank between page load and confirm surfaces as a validation error (SG005)
-- instead of silently labeling a different set of stories than the one he judged.
--
-- Pick bounds (2..4) are FR-012's, and are mirrored in TypeScript by MIN_PICKS / MAX_PICKS in
-- src/lib/selection/rules.ts. The database is authoritative -- the app guard exists to give the
-- operator a live counter, not to be the only enforcement.
--
-- Errors carry distinct SQLSTATEs so the API route maps on `error.code` instead of matching on
-- message text:
--   SG001 -- no such digest
--   SG002 -- digest is not in `ready_for_selection`
--   SG003 -- the pick set is invalid (count out of 2..4, or duplicates)
--   SG004 -- a pick is not on the supplied shortlist
--   SG005 -- the shortlist is empty, has duplicates, or names clusters that are not ranked
--            clusters of this digest
-- A second confirm surfaces as 23505 (unique_violation) on selection.digest_id.
create or replace function public.confirm_selection(
  p_digest_id             uuid,
  p_shortlist_cluster_ids uuid[],
  p_picked_cluster_ids    uuid[],
  p_format                selection_format,
  p_platforms             selection_platform[]
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_status             digest_status;
  v_shortlist_count    int;
  v_shortlist_distinct int;
  v_shortlist_valid    int;
  v_picked_count       int;
  v_picked_distinct    int;
  v_selection_id       uuid;
begin
  -- FOR UPDATE serialises concurrent confirms on the same digest: the second one blocks here,
  -- then reads `generating` and fails with SG002 rather than racing the status check.
  select status into v_status from digest where id = p_digest_id for update;

  if not found then
    raise exception 'digest % not found', p_digest_id
      using errcode = 'SG001';
  end if;

  if v_status <> 'ready_for_selection' then
    raise exception 'digest % is in "%", not "ready_for_selection" -- selection is not open',
      p_digest_id, v_status
      using errcode = 'SG002';
  end if;

  -- --- the shortlist the operator was shown -------------------------------------------------
  v_shortlist_count := coalesce(array_length(p_shortlist_cluster_ids, 1), 0);
  if v_shortlist_count = 0 then
    raise exception 'shortlist is empty' using errcode = 'SG005';
  end if;

  select count(*) into v_shortlist_distinct
    from (select distinct unnest(p_shortlist_cluster_ids) as id) as t;
  if v_shortlist_distinct <> v_shortlist_count then
    raise exception 'shortlist contains duplicate cluster ids' using errcode = 'SG005';
  end if;

  select count(*) into v_shortlist_valid
    from cluster c
   where c.id = any (p_shortlist_cluster_ids)
     and c.digest_id = p_digest_id
     and c.rank is not null;
  if v_shortlist_valid <> v_shortlist_count then
    raise exception 'shortlist names % cluster id(s) that are not ranked clusters of digest %',
      v_shortlist_count - v_shortlist_valid, p_digest_id
      using errcode = 'SG005';
  end if;

  -- --- the operator's picks ------------------------------------------------------------------
  v_picked_count := coalesce(array_length(p_picked_cluster_ids, 1), 0);

  select count(*) into v_picked_distinct
    from (select distinct unnest(p_picked_cluster_ids) as id) as t;
  if v_picked_distinct <> v_picked_count then
    raise exception 'selection contains duplicate cluster ids' using errcode = 'SG003';
  end if;

  if v_picked_count < 2 or v_picked_count > 4 then
    raise exception 'selection must contain between 2 and 4 stories, got %', v_picked_count
      using errcode = 'SG003';
  end if;

  if exists (
    select 1
      from unnest(p_picked_cluster_ids) as t (id)
     where t.id <> all (p_shortlist_cluster_ids)
  ) then
    raise exception 'every selected story must be on the supplied shortlist'
      using errcode = 'SG004';
  end if;

  if cardinality(p_platforms) < 1 then
    raise exception 'at least one target platform is required' using errcode = 'SG003';
  end if;

  -- --- write ---------------------------------------------------------------------------------
  insert into selection (digest_id, format, platforms)
       values (p_digest_id, p_format, p_platforms)
    returning id into v_selection_id;

  -- Every shortlisted cluster gets a row; `picked` is the label (US-10).
  insert into selection_item (selection_id, cluster_id, picked)
  select v_selection_id, t.id, t.id = any (p_picked_cluster_ids)
    from unnest(p_shortlist_cluster_ids) as t (id);

  -- The digest_transition_guard trigger validates this move; ready_for_selection -> generating
  -- is legal, and any other starting status was already rejected above with a clearer message.
  update digest set status = 'generating' where id = p_digest_id;

  return v_selection_id;
end;
$$;

comment on function public.confirm_selection(uuid, uuid[], uuid[], selection_format, selection_platform[]) is
  'S-04: the story selection gate. Validates the digest is awaiting selection and the picks are 2-4 distinct members of the supplied shortlist, writes the selection plus one labeled selection_item per shortlisted cluster, and transitions the digest to generating -- all in one transaction.';

-- ---------------------------------------------------------------------------
-- 5. Row-level security: deny-by-default
-- ---------------------------------------------------------------------------
-- Same posture as digest/cluster/article: RLS on, no policies, so the anon/authenticated roles
-- are denied all access and only the service-role client (which bypasses RLS) reaches these.
alter table selection enable row level security;
alter table selection_item enable row level security;

-- Same trust boundary as the other SECURITY DEFINER functions: both target tables are
-- RLS-enabled deny-by-default, and a SECURITY DEFINER function must not become a way around
-- that. Only the service role -- which already bypasses RLS -- may execute it.
revoke execute on function public.confirm_selection(uuid, uuid[], uuid[], selection_format, selection_platform[]) from public;
revoke execute on function public.confirm_selection(uuid, uuid[], uuid[], selection_format, selection_platform[]) from anon;
revoke execute on function public.confirm_selection(uuid, uuid[], uuid[], selection_format, selection_platform[]) from authenticated;
grant execute on function public.confirm_selection(uuid, uuid[], uuid[], selection_format, selection_platform[]) to service_role;
