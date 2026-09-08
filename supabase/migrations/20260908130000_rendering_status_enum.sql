-- S-06: add the `rendering` state to the digest state machine.
--
-- ALONE IN ITS OWN MIGRATION ON PURPOSE. Postgres refuses to let a value added by
-- `alter type ... add value` be *used* by any other statement in the same transaction
-- ("unsafe use of new value of enum type"). The companion migration
-- 20260908140000_visual_assets.sql redefines enforce_digest_transition() to route through
-- this state, and Supabase applies each migration file in its own transaction -- so the
-- value is committed before anything references it.
--
-- Positioned after 'generating' so the enum reads in pipeline order:
--   collecting -> ranking -> ready_for_selection -> generating -> rendering ->
--   ready_for_approval -> approved -> published
--
-- Nothing else belongs in this file. Adding so much as a comment-free DDL statement that
-- mentions 'rendering' would reintroduce the very error this split exists to avoid.

alter type digest_status add value 'rendering' after 'generating';
