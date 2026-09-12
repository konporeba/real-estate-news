---
change_id: content-approval-gate
title: Content approval gate (human gate 2) + Monday reminder
status: implementing
created: 2026-09-12
updated: 2026-09-12
archived_at: null
---

## Notes

Roadmap slice S-07 (`context/foundation/roadmap.md`). Outcome: operator is emailed that
content is ready, reviews the complete generated post (copy + visuals), and approves or
rejects it before anything publishes — with a Monday reminder email if any step is still
unvalidated.

PRD refs: FR-019, FR-020, FR-021, US-16, US-17.
Prerequisites (all shipped): S-05 (`generated_copy`), S-06 (`generated_asset` PNGs in the
private `digest-assets` bucket), F-04 (email harness), F-05 (scheduler backbone, for the
Monday reminder job).

### Operator decisions, 2026-09-12 (see `research.md` § Open Questions)

- **Reject → a new `rejected` state**, terminal and NOT publishable — deliberately not `skipped`,
  which is US-19's missed-deadline state and stays manually publishable.
- **The Monday reminder watches both human gates** (`ready_for_selection`, `ready_for_approval`)
  and names the outstanding step. **Monday 09:00 `Europe/Warsaw`.**
- **Roadmap OQ#6 closes as "no"** — the reminder ships email-only, no second channel.
- **The approval review gets its own route**, `/dashboard/[id]/approve`.
