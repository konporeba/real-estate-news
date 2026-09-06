-- S-04 impl-review F4: require the submitted shortlist to be COMPLETE.
--
-- 20260829120000_selection_gate.sql validated that every id in p_shortlist_cluster_ids IS a
-- ranked cluster of the digest, but never that the set COVERS all of them. A caller submitting
-- 5 of 15 ids passed every check and wrote 5 selection_item rows.
--
-- That is a silent failure of the table's entire purpose. US-10 wants a 15-story shortlist to
-- yield 15 labeled examples -- 3 picks and 12 passes -- because S-09 consumes the passes as
-- few-shot material. A truncated request loses part of that signal with no error anywhere: the
-- selection succeeds, the digest transitions, and the deficit only ever shows up as a rubric
-- that learned from less than it should have.
--
-- Passing the shortlist from the client stays deliberate (what the operator actually saw is what
-- gets labeled, so a re-rank between page load and confirm surfaces as SG005 rather than
-- silently labeling a different set). This adds the other half of that contract: the set must
-- also be whole. Both directions now raise SG005 -- ids that are not ranked clusters, and ranked
-- clusters that are missing.
--
-- Everything else is unchanged from 20260829120000. The body is repeated in full because
-- `create or replace function` has no partial form; src/lib/selection/rules.test.ts's drift guard
-- already resolves the LATEST migration defining confirm_selection(), so the 2..4 pick bounds
-- below remain the ones it checks against MIN_PICKS / MAX_PICKS.

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
  v_ranked_total       int;
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

  -- NEW (F4): the shortlist must also be complete. Every ranked cluster of this digest has to be
  -- present, or selection_item would hold fewer labeled examples than the operator actually
  -- judged. Checked after the membership test above, so a caller sending wrong ids gets the more
  -- specific complaint first.
  select count(*) into v_ranked_total
    from cluster c
   where c.digest_id = p_digest_id
     and c.rank is not null;
  if v_shortlist_count <> v_ranked_total then
    raise exception
      'shortlist has % of digest %''s % ranked cluster(s) -- every shortlisted story must be submitted so its pick/pass label is recorded',
      v_shortlist_count, p_digest_id, v_ranked_total
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

-- create or replace preserves privileges, but they are restated so this file stands alone as the
-- current definition of the function's trust boundary.
revoke execute on function public.confirm_selection(uuid, uuid[], uuid[], selection_format, selection_platform[]) from public;
revoke execute on function public.confirm_selection(uuid, uuid[], uuid[], selection_format, selection_platform[]) from anon;
revoke execute on function public.confirm_selection(uuid, uuid[], uuid[], selection_format, selection_platform[]) from authenticated;
grant execute on function public.confirm_selection(uuid, uuid[], uuid[], selection_format, selection_platform[]) to service_role;
