---
change_id: weekly-source-collection
roadmap_id: S-01
title: Weekly source collection
status: implementing
created: 2026-07-24
updated: 2026-07-24
prd_refs: [FR-001, FR-002, FR-003, FR-018, US-01, US-02, US-03, US-04]
roadmap: context/foundation/roadmap.md
archived_at: null
---

# S-01: Weekly source collection

Operator can trigger (or the scheduler can auto-run) a week's collection, pulling articles
from a configured source list — resilient to a blocked source and to a thin news week.

Consumes the F-01 run-state contract (`createDigest` → `markStageComplete('collection')` →
`transitionDigest('ranking' | 'failed')`) and writes into `article`. Unlocks S-02 (ranking),
and through it the north-star S-03. See the roadmap for the full dependency graph.

Built with a manual re-trigger first (FR-018) so the downstream pipeline is verifiable before
F-05 automates the Sunday run.

## Notes

Both inherited open questions were resolved by the operator on 2026-07-24:

1. **Source list (OQ#1) — resolved.** 13 candidates verified against live feeds; 9 ship enabled
   on the RSS tier, 3 disabled with the blocking reason recorded (Idealista has no feed and needs
   the rendered tier; Cinco Días and El Economista 403 and need the api tier). Registry:
   `src/lib/collection/sources.ts`.
   **Consequence:** the operator enabled the two Catalan-language sources (Ara, Nació Digital),
   which widens FR-013's translation scope from `es→pl` to `{es,ca}→pl`. That lands on S-02/S-03,
   not on this slice — collection is language-agnostic — but the `language` field on each source
   is what carries the signal downstream.
2. **Late-Sunday window (OQ#7) — resolved: roll into next week.** Windows tile from the previous
   digest's `collection_completed_at` to the current run's start, so the calendar is covered
   exactly once and nothing published late on Sunday is dropped. No declared cutoff to maintain.

### Blocked

Phase 1 (migration-history repair + `collection_report` migration) needs a Supabase CLI session
with access to project `arugswrcmlupwyyumugn`. The currently authenticated account cannot see it
(`supabase projects list` returns only projects in org `jbfesahpgihugmhebhvb`), which is the 403
the plan records. Phases 4-5 write to `collection_report` and cannot complete until this lands.
