---
change_id: resilient-story-generation
title: A week never fails because of article choice — stricter number check plus per-story safety net
status: implemented
created: 2026-10-31
updated: 2026-11-01
archived_at: null
---

## Notes

The 2026-10-26 digest failed generation twice on one figure-dense story ("El precio de las hipotecas escala al 3,08%…", a table of mortgage rates by bank): FR-014 requires every significant figure in the whole article to appear in the copy, which a social post cannot do. The same gate never checks the other direction — a figure the model invents or rounds passes. Operator decision (2026-10-31): copy may contain only figures that exist in the source; headline + lede figures must be present; a story that still fails after its corrective retry is left out (≥ 2 stories must remain) and shown as "Not included" on the approval page. Infrastructure failures (cost ceiling, API down, unconfigured) still fail the week.
