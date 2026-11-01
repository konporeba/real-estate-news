-- week-management: add the `closed` state to the digest state machine.
--
-- ALONE IN ITS OWN MIGRATION ON PURPOSE, for the same reason as
-- 20260912090000_rejected_status_enum.sql: Postgres refuses to let a value added by
-- `alter type ... add value` be used by any other statement in the same transaction. The companion
-- migration 20261101120100_week_management.sql routes the transition guard and the
-- one_active_digest_per_week index through it.
--
-- `closed` is the operator ending a week from the dashboard without publishing it: an outdated
-- week waiting at a gate, an approved one that must not go out, a failure not worth retrying, or a
-- dead run. Unlike `skipped` (US-19's missed deadline, still publishable by hand and still picked up
-- by the Tuesday publish job) a closed week is never published, and it has no way out but delete.

alter type digest_status add value 'closed' after 'skipped';
