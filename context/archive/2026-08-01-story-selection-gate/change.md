---
change_id: story-selection-gate
title: Story selection gate
status: archived
created: 2026-08-01
updated: 2026-09-06
archived_at: 2026-09-06T12:32:24Z
---

## Notes

### Decisions taken during implementation

- **2026-08-29 (Phase 1):** `confirm_selection` raises distinct SQLSTATEs (`SG001`–`SG005`) rather
  than relying on message text, so Phase 3's API route maps on `error.code`. Verified during Phase 1
  that PostgREST passes custom SQLSTATEs through to `error.code` unmodified — this was an
  assumption in the plan, and is now a tested fact.
- **2026-08-29 (approved for Phase 3):** add a drift guard for the pick bounds. The 2–4 rule lives
  in the migration and (from Phase 3) in `MIN_PICKS`/`MAX_PICKS` in `src/lib/selection/rules.ts`;
  the plan flagged "two places that must agree" as an accepted tradeoff. A test that parses
  `supabase/migrations/20260829120000_selection_gate.sql` and fails when the SQL bounds and the TS
  constants diverge closes it, mirroring the technique `src/lib/digest/state-machine.test.ts`
  already uses for the transition map. Scope addition beyond the written plan, approved by the
  operator before Phase 2.
