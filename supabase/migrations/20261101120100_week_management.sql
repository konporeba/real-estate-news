-- week-management: the operator manages weeks from the dashboard.
--
-- The `closed` enum value itself is added by 20261101120000_closed_status_enum.sql, which must run
-- first. This migration adds:
--   * `closed`'s place in the transition guard -- reachable from every state except `published`
--     and `closed` itself, with no way out. The app only offers it for a week that is not being
--     worked on right now (src/lib/digest/week-actions.ts); the trigger stays permissive about
--     working states because a crashed run leaves its week in one, and closing that dead run is the
--     whole point.
--   * ready_for_approval -> rendering: the operator edited a story's text on the approval page, so
--     the slides are redrawn from the edited copy and the week comes back for approval.
--   * one_active_digest_per_week redefined so a closed week frees up its slot, like every other
--     terminal state.

-- ---------------------------------------------------------------------------
-- 1. Transition guard
-- ---------------------------------------------------------------------------
-- Reproduced from 20260912093000_approval_gate.sql, because `create or replace function` replaces
-- the whole body and the drift guard in src/lib/digest/state-machine.test.ts parses the LATEST
-- migration defining this function as the authoritative map. Changes: every non-final state also
-- targets 'closed', and ready_for_approval also targets 'rendering'.

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
    (old.status = 'collecting'          and new.status in ('ranking', 'failed', 'closed')) or
    (old.status = 'ranking'             and new.status in ('ready_for_selection', 'failed', 'closed')) or
    (old.status = 'ready_for_selection' and new.status in ('generating', 'skipped', 'failed', 'closed')) or
    -- S-06: generation hands off to the rendering stage, not straight to the gate.
    (old.status = 'generating'          and new.status in ('rendering', 'failed', 'closed')) or
    (old.status = 'rendering'           and new.status in ('ready_for_approval', 'failed', 'closed')) or
    -- S-07: the operator's decision. 'rejected' is deliberately separate from 'skipped' -- see
    -- 20260912090000_rejected_status_enum.sql for why. week-management: 'rendering' when the
    -- operator edited the text and the slides must be redrawn before they decide.
    (old.status = 'ready_for_approval'  and new.status in ('approved', 'rejected', 'skipped', 'failed', 'rendering', 'closed')) or
    (old.status = 'approved'            and new.status in ('published', 'skipped', 'failed', 'closed')) or
    -- US-19: a missed-deadline digest stays manually publishable
    (old.status = 'skipped'             and new.status in ('published', 'closed')) or
    -- S-07: a rejected digest can be recovered into a fresh generation on the same confirmed
    -- selection. It is never publishable directly.
    (old.status = 'rejected'            and new.status in ('generating', 'closed')) or
    -- FR-018: re-trigger a failed run in place -- from the top for a collection failure, from
    -- the selection gate's output for a generation failure (S-05 impl-review F2), or from the
    -- generated copy for a render failure (S-06), which costs nothing to redo.
    (old.status = 'failed'              and new.status in ('collecting', 'generating', 'rendering', 'closed'))
  ) then
    raise exception 'illegal digest transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. one_active_digest_per_week: closed also frees up its week
-- ---------------------------------------------------------------------------
-- A real recreate statement, not a comment: the drift guard regex-matches the predicate below.

drop index one_active_digest_per_week;

create unique index one_active_digest_per_week
  on digest (window_start)
  where status not in ('published', 'skipped', 'failed', 'rejected', 'closed');
