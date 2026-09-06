-- S-04 Phase 2: record each article's publication language on the row (FR-009a).
--
-- FR-009a requires the shortlist to show the Polish translation WITH the original alongside,
-- "each language-flagged". The app could not do that: language is a property of the SOURCE, and
-- it lives only in the worker-side registry (`src/lib/collection/sources.ts`), which Astro pages
-- are forbidden to import -- eslint.config.js blocks `@/lib/collection/*` from app code because
-- it would drag Node built-ins into the workerd bundle. Denormalising the language onto the
-- article at collection time is what lets the page flag the original without crossing that
-- boundary.
--
-- Nullable, not NOT NULL: a source added to the registry before a backfill lands should render
-- unflagged rather than fail its insert. The page treats null as "unknown language" and omits
-- the flag.

alter table article add column language text;

-- Mirrors SOURCE_LANGUAGES in src/lib/collection/sources.ts. Kept as a check constraint rather
-- than an enum: the set is owned by the source registry, and widening a check is a one-line
-- migration where widening an enum used by a NOT NULL column is not.
alter table article
  add constraint article_language_valid
  check (language is null or language in ('es', 'ca'));

comment on column article.language is
  'S-04/FR-009a: the source publication''s language, denormalised from the collection source registry so the dashboard can flag the original alongside its Polish translation without importing worker-side code.';

-- Backfill from source_name so digests collected before this migration render correctly too,
-- not just future ones. Two sources publish in Catalan -- Ara and Nacio Digital, enabled when
-- Open Roadmap Question #1 was resolved on 2026-07-24; every other source is Spanish.
--
-- CORRECTION (impl-review F5, 2026-09-06): both Catalan sources were DISABLED on 2026-07-31 by
-- commit 9fcaa75, which narrowed the registry to real-estate-scoped feeds. This backfill was
-- still correct and useful -- 111 articles collected before that change carry language = 'ca' --
-- but no NEW collection produces one while they stay disabled, so the 'ca' branch below is
-- historical rather than forward-looking. Re-enabling them in src/lib/collection/sources.ts is
-- the only thing needed to make it live again; nothing here changes.
update article
   set language = case
                    when source_name in ('Ara — Economia', 'Nació Digital — Economia') then 'ca'
                    else 'es'
                  end
 where language is null;
