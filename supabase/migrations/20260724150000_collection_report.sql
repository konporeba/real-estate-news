-- S-01: Weekly source collection — durable per-run collection record
--
--   * digest.collection_report (jsonb) — what each source did on the run
--   * digest_window_order check — deferred from F-01's implementation review (F8)
--
-- No RLS change: digest already has RLS enabled with no policies (deny-by-default,
-- service-role only), and adding a column inherits that.

-- ---------------------------------------------------------------------------
-- 1. collection_report
-- ---------------------------------------------------------------------------
-- Nullable: a digest has no report until collection runs, and a run that dies
-- before writing one must still leave a readable row.
--
-- Shape is owned by src/lib/collection/report.ts (a versioned zod schema) rather
-- than by the database — the per-source entry list is expected to change as tiers
-- are added, and a jsonb column absorbs that without a migration. The point of
-- persisting it is FR-003 diagnosis: a thin week must be explainable from the row
-- alone, without going back to worker logs that may have rotated away.
alter table digest add column collection_report jsonb;

comment on column digest.collection_report is
  'Per-run collection outcome: cutoff bounds, per-source status/counts/errors, pool size, whether fallbacks ran. Validated in application code (src/lib/collection/report.ts), not by the database.';

-- ---------------------------------------------------------------------------
-- 2. Window ordering constraint
-- ---------------------------------------------------------------------------
-- Deferred from F-01 (impl-review finding F8). The collection window resolver
-- reads window_start as its lower-bound fallback, so an inverted window would
-- produce a silently empty pool rather than an error.
alter table digest add constraint digest_window_order
  check (window_end >= window_start);
