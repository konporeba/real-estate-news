-- S-07: content approval gate (FR-019, FR-020, FR-021, US-16, US-17).
--
-- The `rejected` enum value itself is added by 20260912090000_rejected_status_enum.sql, which
-- must run first: a value added by `alter type ... add value` cannot be used in the same
-- transaction. This migration adds:
--   * the `rejected` state's place in the transition guard, and its recovery edge back into
--     `generating` (mirrors `failed -> generating`, S-05 impl-review F2: a cheap stage failure
--     must not force re-paying the whole ranking stage)
--   * `one_active_digest_per_week` redefined so a rejected week frees up its slot, like every
--     other terminal state
--
-- The `approval` table and the `record_approval()` RPC that actually perform the transition this
-- trigger permits live in a SEPARATE later migration (20260912100000_approval_record.sql), not
-- appended here: this file is already applied and recorded in
-- supabase_migrations.schema_migrations by the time that RPC was written, and `supabase migration
-- repair`/`db push` track applied state by file version, not content checksum -- appending to an
-- already-applied file risks a future `db push` skipping the addition entirely.

-- ---------------------------------------------------------------------------
-- 1. Transition guard
-- ---------------------------------------------------------------------------
-- Reproduced verbatim from 20260908140000_visual_assets.sql, because `create or replace function`
-- replaces the whole body and the drift guard in src/lib/digest/state-machine.test.ts parses the
-- LATEST migration defining this function as the authoritative map. TWO clauses change:
--   * ready_for_approval now also targets 'rejected' alongside 'approved', 'skipped', 'failed'
--   * a new rejected -> ('generating') clause, the sole recovery path out of a rejection

create or replace function enforce_digest_transition()
returns trigger
language plpgsql
as $$
begin
  -- Skip validation when the status is not changing (checkpoint / cost writes).
  if new.status = old.status then
    return new;
  end if;

  if not (
    (old.status = 'collecting'          and new.status in ('ranking', 'failed')) or
    (old.status = 'ranking'             and new.status in ('ready_for_selection', 'failed')) or
    (old.status = 'ready_for_selection' and new.status in ('generating', 'skipped', 'failed')) or
    -- S-06: generation hands off to the rendering stage, not straight to the gate.
    (old.status = 'generating'          and new.status in ('rendering', 'failed')) or
    (old.status = 'rendering'           and new.status in ('ready_for_approval', 'failed')) or
    -- S-07: the operator's decision. 'rejected' is deliberately separate from 'skipped' -- see
    -- 20260912090000_rejected_status_enum.sql for why.
    (old.status = 'ready_for_approval'  and new.status in ('approved', 'rejected', 'skipped', 'failed')) or
    (old.status = 'approved'            and new.status in ('published', 'skipped', 'failed')) or
    -- US-19: a missed-deadline digest stays manually publishable
    (old.status = 'skipped'             and new.status = 'published') or
    -- S-07: a rejected digest can be recovered into a fresh generation on the same confirmed
    -- selection -- the only way out of 'rejected'. It is never publishable directly.
    (old.status = 'rejected'            and new.status = 'generating') or
    -- FR-018: re-trigger a failed run in place -- from the top for a collection failure, from
    -- the selection gate's output for a generation failure (S-05 impl-review F2), or from the
    -- generated copy for a render failure (S-06), which costs nothing to redo.
    (old.status = 'failed'              and new.status in ('collecting', 'generating', 'rendering'))
  ) then
    raise exception 'illegal digest transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. one_active_digest_per_week: rejected also frees up its week
-- ---------------------------------------------------------------------------
-- Unlike `rendering` (S-06, deliberately not added here -- a digest being rendered still holds
-- its week), `rejected` IS terminal: nothing moves a rejected digest back onto the calendar
-- except an explicit recovery into `generating`, and the week must be re-collectable until then.
-- The drift guard in src/lib/digest/state-machine.test.ts resolves this index by regex-matching
-- its predicate clause directly out of the migration SQL below -- so it must be a real recreate
-- statement, not merely described in a comment (a comment that echoed the predicate's own
-- wording would confuse that same regex into matching itself instead of the statement below).

drop index one_active_digest_per_week;

create unique index one_active_digest_per_week
  on digest (window_start)
  where status not in ('published', 'skipped', 'failed', 'rejected');
