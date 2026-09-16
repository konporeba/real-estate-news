-- S-08: the publication record and its atomic write function (FR-022, FR-023, US-18, US-19, US-20).
--
-- This migration adds:
--   * publication_status enum       -- 'success' | 'failure', one outcome per platform attempt
--   * publication                   -- one current-truth row per (digest, platform)
--   * record_publication(...)       -- validate + upsert + conditional transition, in one transaction
--   * RLS enabled deny-by-default on `publication` (service-role access only)
--
-- Follows the record_approval precedent (20260912100000_approval_record.sql) exactly: a
-- SECURITY DEFINER function is the only way to make "validate, write, maybe transition" atomic
-- across PostgREST's per-table API, and distinct SQLSTATEs let the API route / worker map on
-- `error.code` instead of message text.
--
-- No changes to enforce_digest_transition() are needed here, unlike every migration before it that
-- touched this table: `approved -> published` and `skipped -> published` already exist (added
-- alongside `rejected` in 20260912093000_approval_gate.sql). This migration is purely additive.

-- ---------------------------------------------------------------------------
-- 1. publication_status vocabulary
-- ---------------------------------------------------------------------------
create type publication_status as enum ('success', 'failure');

-- ---------------------------------------------------------------------------
-- 2. publication (one current-truth row per digest per platform)
-- ---------------------------------------------------------------------------
-- `platform` reuses the existing `selection_platform` enum rather than defining a new one,
-- exactly as `generated_asset.format` reuses `selection_format`. `unique (digest_id, platform)`
-- is what makes a retry an UPSERT rather than a growing history: there is exactly one
-- current-truth row per platform, mirroring generated_asset's "re-running deletes and rewrites"
-- precedent adapted to an upsert (a publish attempt is cheap and idempotent to re-record, unlike a
-- whole re-render).
create table publication (
  id            uuid primary key default gen_random_uuid(),
  digest_id     uuid not null references digest (id) on delete cascade,
  platform      selection_platform not null,
  status        publication_status not null,
  -- The platform's own post/media id on success. Null on failure.
  post_id       text,
  -- The platform's error message on failure, surfaced verbatim to the operator (US-20: per-platform
  -- failure must be visible, not just "something failed"). Null on success.
  error         text,
  published_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (digest_id, platform)
);

create index publication_digest_id_idx on publication (digest_id);

comment on table publication is
  'S-08/US-20: one current-truth row per (digest, platform) publish attempt. A retry overwrites the prior attempt for that platform rather than accumulating rows -- there is one outcome that matters, the most recent one.';

comment on column publication.post_id is
  'S-08: the platform''s own post/media id, present on success. Null on failure.';

comment on column publication.error is
  'S-08/US-20: the platform''s error message, present on failure, so one platform failing is visible and attributable rather than a generic "publish failed".';

-- ---------------------------------------------------------------------------
-- 3. record_publication: validate + write + conditional transition, atomically
-- ---------------------------------------------------------------------------
-- Errors carry distinct SQLSTATEs so the API route / worker map on `error.code` instead of
-- matching on message text:
--   PB001 -- no such digest
--   PB002 -- digest is not in ('approved', 'skipped', 'published')
create or replace function public.record_publication(
  p_digest_id uuid,
  p_platform  selection_platform,
  p_status    publication_status,
  p_post_id   text,
  p_error     text
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_status         digest_status;
  v_publication_id uuid;
begin
  -- FOR UPDATE serialises concurrent publish attempts on the same digest: a scheduled fire racing
  -- a manual retrigger blocks here rather than both reading 'approved' and double-transitioning.
  select status into v_status from digest where id = p_digest_id for update;

  if not found then
    raise exception 'digest % not found', p_digest_id
      using errcode = 'PB001';
  end if;

  -- 'published' is a legal starting status, not just 'approved'/'skipped': a retry after some
  -- platforms already succeeded (the digest is already 'published') must still be able to record
  -- the remaining platforms. Anything earlier in the pipeline, or 'rejected'/'failed', has nothing
  -- approved to publish and is refused.
  if v_status not in ('approved', 'skipped', 'published') then
    raise exception 'digest % is in "%", not approved/skipped/published -- nothing to publish',
      p_digest_id, v_status
      using errcode = 'PB002';
  end if;

  insert into publication (digest_id, platform, status, post_id, error)
       values (p_digest_id, p_platform, p_status, p_post_id, p_error)
  on conflict (digest_id, platform) do update
    set status       = excluded.status,
        post_id       = excluded.post_id,
        error         = excluded.error,
        published_at  = excluded.published_at
    returning id into v_publication_id;

  -- The digest moves to 'published' the first time ANY platform succeeds, and only from a status
  -- that still means "not yet published" -- a success recorded while already 'published' is a
  -- later-platform catching up, not a fresh transition, so the guard below is what keeps this
  -- idempotent rather than re-firing a no-op update through the transition trigger.
  if p_status = 'success' and v_status in ('approved', 'skipped') then
    update digest set status = 'published' where id = p_digest_id;
  end if;

  return v_publication_id;
end;
$$;

comment on function public.record_publication(uuid, selection_platform, publication_status, text, text) is
  'S-08: records one platform''s publish outcome and, on the first success, transitions the digest to published -- all in one transaction. A retry (including after some platforms already succeeded) is legal as long as the digest is approved, skipped, or already published.';

-- ---------------------------------------------------------------------------
-- 4. Row-level security: deny-by-default
-- ---------------------------------------------------------------------------
-- Same posture as digest/cluster/article/selection/generated_copy/generated_asset/approval: RLS
-- on, no policies, so the anon and authenticated roles are denied all access and only the
-- service-role client (which bypasses RLS) reaches this table.
alter table publication enable row level security;

-- Same trust boundary as record_approval/confirm_selection: `publication` is RLS-enabled
-- deny-by-default, and a SECURITY DEFINER function must not become a way around that. Only the
-- service role -- which already bypasses RLS -- may execute it.
revoke execute on function public.record_publication(uuid, selection_platform, publication_status, text, text)
  from public;
revoke execute on function public.record_publication(uuid, selection_platform, publication_status, text, text)
  from anon;
revoke execute on function public.record_publication(uuid, selection_platform, publication_status, text, text)
  from authenticated;
grant execute on function public.record_publication(uuid, selection_platform, publication_status, text, text)
  to service_role;
