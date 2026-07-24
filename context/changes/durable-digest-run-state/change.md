---
change_id: durable-digest-run-state
roadmap_id: F-01
title: Durable digest run-state & core schema
status: impl_reviewed
created: 2026-07-22
updated: 2026-07-24
prd_refs: [NFR-durability, FR-001, FR-004]
roadmap: context/foundation/roadmap.md
---

# F-01: Durable digest run-state & core schema

The durable persistence backbone the multi-day weekly pipeline resumes on: the digest
state machine, per-stage checkpoints, and the core `digest`/`article`/`cluster` schema
with deny-by-default RLS and a typed app-facing run-state module.

Unlocks S-01 (collection), S-02 (ranking), S-03 (shortlist view). See the roadmap for
the full dependency graph.
