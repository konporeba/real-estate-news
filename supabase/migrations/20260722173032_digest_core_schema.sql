-- F-01: Durable digest run-state & core schema
--
-- Creates the minimal backbone the multi-day weekly digest pipeline resumes on:
--   * digest_status enum (the state machine's states)
--   * digest / cluster / article tables (created in FK-safe order)
--   * per-stage checkpoint timestamps + running-cost column on digest
--   * partial unique index: at most one non-terminal digest per ISO week
--   * BEFORE UPDATE transition-guard trigger: illegal status moves are rejected
--   * BEFORE UPDATE updated_at trigger
--   * RLS enabled deny-by-default on all three tables (service-role access only)
--
-- Downstream slices (S-01 collection, S-02 ranking, S-03 shortlist view) write to
-- these tables. Later slices own selection / generated_asset / publication /
-- feedback_label; those are deliberately NOT created here.

-- ---------------------------------------------------------------------------
-- 1. Status enum
-- ---------------------------------------------------------------------------
create type digest_status as enum (
  'collecting',
  'ranking',
  'ready_for_selection',
  'generating',
  'ready_for_approval',
  'approved',
  'published',
  'skipped',
  'failed'
);

-- ---------------------------------------------------------------------------
-- 2. digest (the weekly run + its durable state)
-- ---------------------------------------------------------------------------
create table digest (
  id                       uuid primary key default gen_random_uuid(),
  window_start             date not null,
  window_end               date not null,
  status                   digest_status not null default 'collecting',
  cost_usd                 numeric(10, 4) not null default 0,
  -- per-stage checkpoints: on restart the worker resumes from the last completed stage
  collection_completed_at  timestamptz,
  ranking_completed_at     timestamptz,
  translation_completed_at timestamptz,
  last_error               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- At most one active (non-terminal) digest per week. A scheduled Sunday run
-- colliding with a manual re-trigger fails cleanly instead of double-inserting.
-- Terminal states are excluded so a failed/skipped/published week can be re-run.
create unique index one_active_digest_per_week
  on digest (window_start)
  where status not in ('published', 'skipped', 'failed');

-- ---------------------------------------------------------------------------
-- 3. cluster (groups articles telling the same story; scored + ranked)
-- ---------------------------------------------------------------------------
create table cluster (
  id              uuid primary key default gen_random_uuid(),
  digest_id       uuid not null references digest (id) on delete cascade,
  relevance_score numeric(4, 2),
  coverage_count  int not null default 1,
  rank            int,
  created_at      timestamptz not null default now()
);

create index cluster_digest_id_idx on cluster (digest_id);

-- ---------------------------------------------------------------------------
-- 4. article (a collected source article; assigned to a cluster during ranking)
-- ---------------------------------------------------------------------------
create table article (
  id             uuid primary key default gen_random_uuid(),
  digest_id      uuid not null references digest (id) on delete cascade,
  cluster_id     uuid references cluster (id) on delete set null,
  source_name    text not null,
  source_url     text not null,
  published_at   timestamptz,
  original_title text not null,
  original_lede  text,
  polish_title   text,
  polish_summary text,
  created_at     timestamptz not null default now(),
  -- prevent duplicate fetches of the same URL within one run
  unique (digest_id, source_url)
);

create index article_digest_id_idx on article (digest_id);
create index article_cluster_id_idx on article (cluster_id);

-- ---------------------------------------------------------------------------
-- 5. Transition-guard trigger (illegal status transitions are impossible)
-- ---------------------------------------------------------------------------
-- The database is authoritative for the state machine; a buggy worker cannot
-- persist an illegal state. No-op updates (status unchanged, e.g. a checkpoint
-- write) pass through untouched.
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
    -- FR-018: re-trigger a failed run in place
    (old.status = 'failed'              and new.status = 'collecting')
  ) then
    raise exception 'illegal digest transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger digest_transition_guard
  before update of status on digest
  for each row
  execute function enforce_digest_transition();

-- ---------------------------------------------------------------------------
-- 6. updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger digest_set_updated_at
  before update on digest
  for each row
  execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Row-level security: deny-by-default
-- ---------------------------------------------------------------------------
-- RLS is enabled with NO policies, so the anon/authenticated roles (the
-- publishable key / PostgREST) are denied all access. Server-side code reaches
-- these tables only via the service-role client, which bypasses RLS. This is
-- intentional: the private-path + PIN gate is the real access control, and this
-- is defense-in-depth against accidental exposure through the public key.
alter table digest enable row level security;
alter table cluster enable row level security;
alter table article enable row level security;
