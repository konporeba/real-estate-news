-- S-05: Polish copy generation (FR-013, FR-014, US-11, US-12).
--
-- The generation half of the tables F-01's core schema deferred ("Later slices own selection /
-- generated_asset / publication / feedback_label; those are deliberately NOT created here").
-- S-04 took `selection` / `selection_item`; this migration adds:
--   * generated_copy               -- one adapted story: the Polish post the operator will publish
--   * digest.generation_completed_at -- the stage checkpoint `digest` was missing
--   * RLS enabled deny-by-default (service-role access only)
--
-- One row per SELECTED cluster, not per shortlisted one. selection_item covers the whole
-- shortlist because its purpose is labeling (picks AND passes, US-10); this table covers only
-- what was picked, because its purpose is the published artifact.

-- ---------------------------------------------------------------------------
-- 1. digest: the generation stage's checkpoint
-- ---------------------------------------------------------------------------
-- Mirrors collection_completed_at / ranking_completed_at / translation_completed_at. Nullable
-- like its siblings: a digest that has not reached generation simply has no timestamp.
alter table digest add column generation_completed_at timestamptz;

comment on column digest.generation_completed_at is
  'S-05: when the generation stage finished writing generated_copy rows. Mirrors the other per-stage checkpoints; NULL until the stage completes.';

-- ---------------------------------------------------------------------------
-- 2. generated_copy
-- ---------------------------------------------------------------------------
create table generated_copy (
  id                 uuid primary key default gen_random_uuid(),
  digest_id          uuid not null references digest (id) on delete cascade,
  cluster_id         uuid not null references cluster (id) on delete cascade,
  -- FR-013's four outputs. All not null: a row exists only when generation produced a complete
  -- adaptation, and a partial row would reach the S-07 approval gate looking publishable.
  polish_title       text not null,
  caption_summary    text not null,
  body_copy          text not null,
  -- An array of {label, value} objects. jsonb rather than a child table: a statistic is a pair,
  -- the count varies (3-5), and neither S-06's slot filling nor S-07's rendering queries inside
  -- it. The numeric gate runs in TypeScript against the source text, not against this column.
  key_statistics     jsonb not null,
  -- Which source material this copy actually rests on. 'article' means the story's page was
  -- fetched and its body extracted; 'lede' means that failed (a blocked source, a paywall, an
  -- unparseable layout) and generation fell back to the stored title + lede. The operator sees
  -- this at the S-07 approval gate, so a post that reads short is explained rather than
  -- mysterious -- and a source that has started blocking us shows up as a data pattern.
  source_text_origin text not null,
  -- How much source text the model actually received. Diagnostic only: it is what distinguishes
  -- "the fallback fired" from "the article itself was thin".
  source_char_count  integer,
  created_at         timestamptz not null default now(),
  -- One adaptation per story per digest. Re-running generation deletes and rewrites rather than
  -- appending, so this constraint is what makes a duplicate a loud error instead of a silent
  -- second post.
  unique (digest_id, cluster_id),
  constraint generated_copy_source_text_origin_valid
    check (source_text_origin in ('article', 'lede')),
  -- A guard, not validation: the shape is enforced in TypeScript by the generation schema. This
  -- only stops a non-array from being stored, which would break S-06's slot filling at render
  -- time rather than at write time.
  constraint generated_copy_key_statistics_is_array
    check (jsonb_typeof(key_statistics) = 'array')
);

create index generated_copy_digest_id_idx on generated_copy (digest_id);

comment on table generated_copy is
  'S-05/FR-013: one Polish social adaptation per selected story -- title, caption summary, body copy for the confirmed format, and pulled-out key statistics. S-06 fills visual template slots from these columns; S-07 renders them at the approval gate.';

comment on column generated_copy.source_text_origin is
  'S-05: ''article'' when the story''s page was fetched and its body extracted, ''lede'' when that failed and generation fell back to the stored title + lede. Surfaced at the approval gate so a short post is explained.';

-- ---------------------------------------------------------------------------
-- 3. Row-level security: deny-by-default
-- ---------------------------------------------------------------------------
-- Same posture as digest/cluster/article/selection: RLS on, no policies, so the anon and
-- authenticated roles are denied all access and only the service-role client (which bypasses
-- RLS) reaches this table.
alter table generated_copy enable row level security;
