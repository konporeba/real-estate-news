-- S-05 impl-review F2: let a failed generation be retried in place.
--
-- Before this, `failed` had exactly one outgoing move: back to `collecting`. That is right for a
-- run that failed during collection, but wrong for one that failed during generation — it
-- discards the operator's confirmed selection and re-pays clustering, scoring and translation
-- (measured at $0.3618 on digest c92aa3c5) to recover from a stage that costs cents. Every
-- generation failure mode landed there: an LLM api_error, a ceiling hit, and a numeric-gate
-- failure. FR-018 asks for a failed run to be "re-triggered in place"; this makes that true of
-- the generation stage too, not only of collection.
--
-- Only ONE clause changes: `failed -> generating` is added. Everything else is reproduced
-- verbatim from 20260722173032_digest_core_schema.sql, because `create or replace function`
-- replaces the whole body and the drift guard in src/lib/digest/state-machine.test.ts parses the
-- LATEST migration defining this function as the authoritative map.
--
-- Note the interaction with `one_active_digest_per_week`: that partial unique index excludes
-- terminal states, so moving a failed digest back to a non-terminal one is refused if another
-- active digest already holds the same week. That is the existing behaviour of `failed ->
-- collecting`, unchanged here — the week is claimed by whoever is active in it.

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
    (old.status = 'generating'          and new.status in ('ready_for_approval', 'failed')) or
    (old.status = 'ready_for_approval'  and new.status in ('approved', 'skipped', 'failed')) or
    (old.status = 'approved'            and new.status in ('published', 'skipped', 'failed')) or
    -- US-19: a missed-deadline digest stays manually publishable
    (old.status = 'skipped'             and new.status = 'published') or
    -- FR-018: re-trigger a failed run in place -- from the top for a collection failure,
    -- or from the selection gate's output for a generation failure (S-05 impl-review F2).
    (old.status = 'failed'              and new.status in ('collecting', 'generating'))
  ) then
    raise exception 'illegal digest transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
