-- S-04 impl-review F2: correct selection_item's indexes.
--
-- 20260829120000_selection_gate.sql created `selection_item_selection_id_idx (selection_id)`
-- alongside `unique (selection_id, cluster_id)`. The unique constraint's own btree index already
-- leads with selection_id, so any query filtering on that column can use it -- the separate index
-- served no read and only cost an extra write per row and its own storage.
--
-- The direction that IS unindexed is the reverse one: cluster_id. S-09 (archive-and-learning-loop)
-- reads this table as few-shot material for the ranking rubric, which means asking "was this
-- cluster picked or passed" -- a cluster_id lookup. The foreign key to cluster does not create an
-- index on the referencing side in Postgres, so that lookup is a sequential scan today.
--
-- Net effect: one redundant index removed, one missing index added.

drop index if exists selection_item_selection_id_idx;

create index selection_item_cluster_id_idx on selection_item (cluster_id);

comment on index selection_item_cluster_id_idx is
  'S-09 reads selection_item by cluster to recover the operator''s pick/pass label for a story. The (selection_id, cluster_id) unique index cannot serve that lookup -- cluster_id is not its leading column.';
