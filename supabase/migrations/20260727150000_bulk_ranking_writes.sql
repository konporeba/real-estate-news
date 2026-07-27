-- S-02 impl-review F1: bulk writes for the ranking stage's persist path.
--
-- rank.ts previously assigned each cluster's articles and wrote each cluster's score/rank via
-- one `.update()` call per cluster in a loop -- on a real ~368-article pool (~250 clusters) that
-- is ~500 sequential round trips for persistence alone. PostgREST cannot express "update N rows
-- to N different values" as a single `.upsert()` without supplying every NOT NULL column
-- (Supabase's generated Insert type, which `.upsert()` is typed against, requires them), so this
-- adds two SQL functions that take parallel arrays and do the whole batch as one UPDATE ... FROM
-- unnest(...) each -- the same "PostgREST can't express it, so make it a function" precedent as
-- `increment_digest_cost` (F-03).

create or replace function public.assign_articles_to_clusters(p_article_ids uuid[], p_cluster_ids uuid[])
  returns void
  language sql
  security definer
  set search_path = public
as $$
  update article
     set cluster_id = data.cluster_id
    from (
      select unnest(p_article_ids) as article_id, unnest(p_cluster_ids) as cluster_id
    ) as data
   where article.id = data.article_id;
$$;

comment on function public.assign_articles_to_clusters(uuid[], uuid[]) is
  'S-02: bulk-assign article.cluster_id from two parallel arrays (article ids, their cluster id), one round trip instead of one .update() per cluster.';

create or replace function public.persist_cluster_rankings(
  p_cluster_ids uuid[],
  p_scores numeric[],
  p_details jsonb[],
  p_ranks int[]
)
  returns void
  language sql
  security definer
  set search_path = public
as $$
  update cluster
     set relevance_score = data.score,
         scoring_detail = data.detail,
         rank = data.rank
    from (
      select
        unnest(p_cluster_ids) as cluster_id,
        unnest(p_scores) as score,
        unnest(p_details) as detail,
        unnest(p_ranks) as rank
    ) as data
   where cluster.id = data.cluster_id;
$$;

comment on function public.persist_cluster_rankings(uuid[], numeric[], jsonb[], int[]) is
  'S-02: bulk-write relevance_score, scoring_detail, and shortlist rank from four parallel arrays, one round trip instead of one .update() per cluster. p_ranks entries may be null (rank-null clusters outside the top 15).';

-- Same trust boundary as increment_digest_cost: both target tables are RLS-enabled
-- deny-by-default, and a SECURITY DEFINER function must not become a way around that.
revoke execute on function public.assign_articles_to_clusters(uuid[], uuid[]) from public;
revoke execute on function public.assign_articles_to_clusters(uuid[], uuid[]) from anon;
revoke execute on function public.assign_articles_to_clusters(uuid[], uuid[]) from authenticated;
grant execute on function public.assign_articles_to_clusters(uuid[], uuid[]) to service_role;

revoke execute on function public.persist_cluster_rankings(uuid[], numeric[], jsonb[], int[]) from public;
revoke execute on function public.persist_cluster_rankings(uuid[], numeric[], jsonb[], int[]) from anon;
revoke execute on function public.persist_cluster_rankings(uuid[], numeric[], jsonb[], int[]) from authenticated;
grant execute on function public.persist_cluster_rankings(uuid[], numeric[], jsonb[], int[]) to service_role;
