---
change_id: weekly-source-collection
roadmap_id: S-01
title: Weekly source collection
status: new
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

Open questions carried in from the roadmap — neither blocks starting, both shape the design:

1. **Exact source list, and which sources expose RSS vs need an API vs a rendered fetch**
   (PRD OQ#1, owner: operator). Per-source tiering (RSS → API → rendered fetch) is the fragile
   surface; Idealista in particular blocks scrapers.
2. **Late-Sunday window** — shrink the declared window to Sun 17:00, or roll late items into
   next week (PRD OQ#7, owner: operator).
