-- S-07: the approval record and the whole gate as one atomic function (FR-019, FR-020, US-16).
--
-- The `rejected` enum value and the transition trigger/index that permit this stage's moves were
-- added by 20260912090000_rejected_status_enum.sql and 20260912093000_approval_gate.sql, both
-- already applied and recorded in supabase_migrations.schema_migrations by the time this file was
-- written -- see that file's own header for why the approval table and RPC live here instead of
-- being appended to it. This migration adds:
--   * approval_decision enum       -- 'approved' | 'rejected', mirrors the two live transitions
--   * approval                     -- one row per decision, the operator's record (FR-020)
--   * record_approval(...)         -- validate + write + transition, in one transaction
--   * RLS enabled deny-by-default on `approval` (service-role access only)
--
-- Follows the confirm_selection precedent (20260829120000_selection_gate.sql) exactly: a
-- SECURITY DEFINER function is the only way to make "validate, write, transition" atomic across
-- PostgREST's per-table API, and distinct SQLSTATEs let the API route map on `error.code` instead
-- of message text.

-- ---------------------------------------------------------------------------
-- 1. approval_decision vocabulary
-- ---------------------------------------------------------------------------
-- Deliberately the SAME two names as their digest_status targets ('approved', 'rejected') --
-- record_approval() casts through text to move the digest, so a decision value IS the status it
-- produces. Created with `create type`, not `alter type ... add value`, so it is safe to use in
-- the same transaction as everything else below.
create type approval_decision as enum ('approved', 'rejected');

-- ---------------------------------------------------------------------------
-- 2. approval (one row per decision)
-- ---------------------------------------------------------------------------
-- `digest_id` is UNIQUE, mirroring `selection`: it is what makes a second decision a loud 23505
-- rather than a silent overwrite, independently of the digest state machine. Rows are immutable
-- once written (no updated_at trigger) -- a decision is a historical record, not mutable state,
-- and FR-025's learning loop (S-09) reads it as-is.
create table approval (
  id          uuid primary key default gen_random_uuid(),
  digest_id   uuid not null unique references digest (id) on delete cascade,
  decision    approval_decision not null,
  -- Optional (US-16 asks for approve-or-reject, not a mandatory reason). Bounded so an operator
  -- pasting an entire article can't turn a decision record into an unbounded text blob.
  note        text,
  decided_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint approval_note_length check (note is null or char_length(note) <= 2000)
);

create index approval_digest_id_idx on approval (digest_id);

comment on table approval is
  'S-07/FR-020: the operator''s approve-or-reject decision for one digest, with an optional note. One row per digest, enforced by the unique constraint on digest_id -- a decision is a historical record, never revised.';

comment on column approval.note is
  'S-07: optional free-text reason, mainly expected on a rejection. FR-025''s learning loop (S-09) is the intended consumer, the same reason S-04 stores passes alongside picks.';

-- ---------------------------------------------------------------------------
-- 3. record_approval: the whole gate, atomically
-- ---------------------------------------------------------------------------
-- Errors carry distinct SQLSTATEs so the API route maps on `error.code` instead of matching on
-- message text:
--   AG001 -- no such digest
--   AG002 -- digest is not in `ready_for_approval`
--   AG003 -- note exceeds the length limit
-- A second decision surfaces as 23505 (unique_violation) on approval.digest_id.
create or replace function public.record_approval(
  p_digest_id uuid,
  p_decision  approval_decision,
  p_note      text
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_status      digest_status;
  v_approval_id uuid;
begin
  -- FOR UPDATE serialises concurrent decisions on the same digest: the second one blocks here,
  -- then reads the new status and fails with AG002 rather than racing the check below.
  select status into v_status from digest where id = p_digest_id for update;

  if not found then
    raise exception 'digest % not found', p_digest_id
      using errcode = 'AG001';
  end if;

  if v_status <> 'ready_for_approval' then
    raise exception 'digest % is in "%", not "ready_for_approval" -- the approval gate is not open',
      p_digest_id, v_status
      using errcode = 'AG002';
  end if;

  if p_note is not null and char_length(p_note) > 2000 then
    raise exception 'note exceeds the 2000-character limit' using errcode = 'AG003';
  end if;

  insert into approval (digest_id, decision, note)
       values (p_digest_id, p_decision, p_note)
    returning id into v_approval_id;

  -- p_decision's two members ('approved', 'rejected') are also digest_status members, so the
  -- decision IS the status it produces -- no case/when mapping needed. The digest state
  -- machine's own transition-guard trigger (see 20260912093000_approval_gate.sql) still
  -- validates this move underneath; ready_for_approval -> approved and ready_for_approval ->
  -- rejected are both legal there, and any other starting status was already rejected above with
  -- a clearer message than that trigger's own check_violation would give. Naming the trigger
  -- function here by its exact identifier is deliberately avoided -- the drift guard in
  -- src/lib/digest/state-machine.test.ts resolves "the migration defining it" by searching for
  -- that literal name, and would otherwise resolve to this file, which never defines it.
  update digest set status = (p_decision::text)::digest_status where id = p_digest_id;

  return v_approval_id;
end;
$$;

comment on function public.record_approval(uuid, approval_decision, text) is
  'S-07: the content approval gate. Validates the digest is awaiting approval, writes the decision (with an optional note), and transitions the digest to approved or rejected -- all in one transaction.';

-- ---------------------------------------------------------------------------
-- 4. Row-level security: deny-by-default
-- ---------------------------------------------------------------------------
-- Same posture as digest/cluster/article/selection/generated_copy/generated_asset: RLS on, no
-- policies, so the anon and authenticated roles are denied all access and only the service-role
-- client (which bypasses RLS) reaches this table.
alter table approval enable row level security;

-- Same trust boundary as confirm_selection: `approval` is RLS-enabled deny-by-default, and a
-- SECURITY DEFINER function must not become a way around that. Only the service role -- which
-- already bypasses RLS -- may execute it.
revoke execute on function public.record_approval(uuid, approval_decision, text) from public;
revoke execute on function public.record_approval(uuid, approval_decision, text) from anon;
revoke execute on function public.record_approval(uuid, approval_decision, text) from authenticated;
grant execute on function public.record_approval(uuid, approval_decision, text) to service_role;
