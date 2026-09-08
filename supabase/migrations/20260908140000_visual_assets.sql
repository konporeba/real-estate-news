-- S-06: per-platform brand visual assets (FR-015, US-13, US-14).
--
-- The visual half of the tables F-01's core schema deferred ("Later slices own selection /
-- generated_asset / publication / feedback_label; those are deliberately NOT created here").
-- S-04 took `selection` / `selection_item`, S-05 took `generated_copy`; this migration adds:
--   * the `rendering` stage's place in the transition guard
--   * digest.rendering_completed_at   -- the stage checkpoint
--   * generated_asset                 -- one rendered image per slide
--   * a private Storage bucket to hold the bytes
--
-- WHY A SEPARATE STATE rather than folding rendering into `generating`: S-05's impl-review
-- established that a stage which can fail needs a recovery path proportional to its cost. Copy
-- generation costs dollars; rendering costs nothing but a few API calls. Folding them together
-- would mean a transient Google Slides error forces re-paying the whole generation stage --
-- exactly the mistake `failed -> generating` was added to fix in 20260908120000.
--
-- The enum value itself is added by 20260908130000_rendering_status_enum.sql, which must run
-- first: a value added by `alter type ... add value` cannot be used in the same transaction.

-- ---------------------------------------------------------------------------
-- 1. Transition guard
-- ---------------------------------------------------------------------------
-- Reproduced verbatim from 20260908120000_failed_generation_retry.sql, because
-- `create or replace function` replaces the whole body and the drift guard in
-- src/lib/digest/state-machine.test.ts parses the LATEST migration defining this function as
-- the authoritative map. THREE clauses change:
--   * generating now targets ('rendering', 'failed') instead of ('ready_for_approval', 'failed')
--   * a new rendering -> ('ready_for_approval', 'failed') clause
--   * failed gains 'rendering', so a render failure retries in place (FR-018) without
--     discarding the copy that generation already paid for
--
-- The `one_active_digest_per_week` partial unique index is deliberately NOT redefined here.
-- Its predicate names only the terminal states, and `rendering` is not one of them, so a digest
-- being rendered correctly continues to hold its week.

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
    -- S-06: generation now hands off to the rendering stage, not straight to the gate.
    (old.status = 'generating'          and new.status in ('rendering', 'failed')) or
    (old.status = 'rendering'           and new.status in ('ready_for_approval', 'failed')) or
    (old.status = 'ready_for_approval'  and new.status in ('approved', 'skipped', 'failed')) or
    (old.status = 'approved'            and new.status in ('published', 'skipped', 'failed')) or
    -- US-19: a missed-deadline digest stays manually publishable
    (old.status = 'skipped'             and new.status = 'published') or
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
-- 2. digest: the rendering stage's checkpoint
-- ---------------------------------------------------------------------------
-- Mirrors collection_completed_at / ranking_completed_at / translation_completed_at /
-- generation_completed_at. Nullable like its siblings.
alter table digest add column rendering_completed_at timestamptz;

comment on column digest.rendering_completed_at is
  'S-06: when the rendering stage finished writing generated_asset rows. Mirrors the other per-stage checkpoints; NULL until the stage completes.';

-- ---------------------------------------------------------------------------
-- 3. generated_asset
-- ---------------------------------------------------------------------------
-- One row per rendered image. The unit is a SLIDE, not a story: a carousel's cover slide
-- belongs to the digest as a whole and has no cluster, which is why cluster_id is nullable.
--
-- No `platform` column, deliberately. One square 1080x1080 template per format serves
-- Instagram, LinkedIn and Facebook alike, so the same image is published to every selected
-- platform and a platform column would be a constant. Which asset actually went where is
-- S-08's `publication` table to record, not this one. If per-platform templates ever arrive,
-- adding the column then is a cheap migration; encoding a distinction that does not exist
-- today would be a lie in the schema.
create table generated_asset (
  id           uuid primary key default gen_random_uuid(),
  digest_id    uuid not null references digest (id) on delete cascade,
  -- NULL for a carousel cover slide, which represents the week rather than one story.
  cluster_id   uuid references cluster (id) on delete cascade,
  -- Publication order within the post. 0 is the first slide; for a carousel that is the cover.
  slide_index  integer not null,
  -- Object path within the storage bucket, NOT a URL. Slides' own export URLs live 30 minutes,
  -- so nothing time-limited may be persisted here -- FR-024 wants this readable years later.
  storage_path text not null,
  -- Recorded as rendered rather than assumed: the export resolution is the API's choice, not
  -- ours, and S-07/S-08 should be able to see what they are actually publishing.
  width        integer,
  height       integer,
  -- Which template produced this, so a carousel asset is never mistaken for a single post.
  format       selection_format not null,
  created_at   timestamptz not null default now(),
  -- One image per slide per digest. Re-running the stage deletes and rewrites rather than
  -- appending, so this constraint turns a duplicate into a loud error instead of a silent
  -- second copy of slide 2.
  unique (digest_id, slide_index),
  constraint generated_asset_slide_index_non_negative check (slide_index >= 0)
);

create index generated_asset_digest_id_idx on generated_asset (digest_id);

comment on table generated_asset is
  'S-06/FR-015: one rendered image per published slide, filled from an operator-owned Google Slides template. The bytes live in the digest-assets storage bucket; storage_path addresses them.';

comment on column generated_asset.cluster_id is
  'S-06: the story this slide shows, or NULL for a carousel cover slide, which belongs to the digest rather than to any one story.';

-- ---------------------------------------------------------------------------
-- 4. Row-level security: deny-by-default
-- ---------------------------------------------------------------------------
-- Same posture as digest/cluster/article/selection/generated_copy: RLS on, no policies, so the
-- anon and authenticated roles are denied all access and only the service-role client (which
-- bypasses RLS) reaches this table.
alter table generated_asset enable row level security;

-- ---------------------------------------------------------------------------
-- 5. Storage bucket
-- ---------------------------------------------------------------------------
-- Private (public = false): the dashboard reaches these through signed URLs minted by the
-- service-role client behind the F-02 PIN gate, never by guessable public path. No policies are
-- added on storage.objects for the same reason no policies exist on the domain tables -- the
-- service role bypasses RLS and is the only intended reader.
insert into storage.buckets (id, name, public)
values ('digest-assets', 'digest-assets', false)
on conflict (id) do nothing;
