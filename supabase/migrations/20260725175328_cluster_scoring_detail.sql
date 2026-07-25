-- S-02: persist the rubric's tier/topics/rationale alongside the numeric relevance_score.
--
-- cluster.relevance_score (numeric(4,2), from F-01) is the queryable number ranking sorts on. The
-- geography tier, topic tags, and one-line rationale the rubric also produces cannot live in that
-- column, so they go in a jsonb blob — the same split S-01 used for digest.collection_report. The
-- shape is validated in application code (src/lib/ranking/score.ts), not by the database.
--
-- Nullable: a cluster has no scoring detail until the ranking stage scores it. No RLS change:
-- cluster already has RLS enabled with no policies (deny-by-default, service-role only).
alter table cluster add column scoring_detail jsonb;

comment on column cluster.scoring_detail is
  'S-02 rubric output: geography tier, topic tags, and rationale behind relevance_score. Validated in application code (src/lib/ranking/score.ts), not by the database. Feeds S-09''s archive/learning loop.';
