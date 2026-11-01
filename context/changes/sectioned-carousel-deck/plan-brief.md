# Sectioned Carousel Deck — Plan Brief

> Full plan: `context/changes/sectioned-carousel-deck/plan.md`

## What & Why

The operator redesigned the carousel template: one weekly cover plus 20 photo slides in three sections —
Barcelona, Hiszpania, and Ceny/kredyty/podatki/prawo — at 4:5. The pipeline should build one combined
weekly carousel from it, putting each story on a photo slide from a matching section and mixing sections
for visual variety, which the operator expects to lift engagement.

## Starting Point

The renderer finds template slides by position and expects a 2-slide square deck with three statistics per
story; the new deck fails validation. Ranking already knows each story's geography (Catalonia / national /
global), but nothing marks finance/law stories. The approval page assumes square images.

## Desired End State

`npm run visuals` turns a week's 2–4 picked stories into: the cover, then one slide per story, each from a
section the story fits, title and description in one auto-sized box. The shortlist shows which stories are
finance/law. A `visuals:preview` command shows every slide filled with sample text, with no data written.

## Key Decisions Made

| Decision | Choice | Why |
| --- | --- | --- |
| Output shape | One combined carousel per week | Operator's call: more variety in a single post |
| Cover | Single cover slide; no date range | "TYGODNIOWE PODSUMOWANIE" is self-explanatory |
| Slide lookup | Speaker-note tags (`role=`, `section=`) | Operator can add/remove/reorder photos without code changes |
| Story fits two sections | One slide, from the section used least so far; tie → geography | Variety without duplicating stories |
| Finance/law detection | Ranking adds a yes/no flag | Visible at selection time; one consistent judgment |
| Title vs description | One shared text box, two paragraphs | Description flows under any title length; no overlap |
| Text too long | Step font down; past the last step, stop with a diagnostic | Never publish overflowing text |
| Deck edit | Claude migrates the 20 slides via API | Identical result on every slide, checked by the validator |
| Testing | Local preview PNGs + one real weekly run | See every variant, then prove the real flow |
| Deploy | Commit the pending dashboard redesign first; deploy only on operator's go | Clean history; nothing ships untested |
| Single-post deck | Unchanged | Operator reworks it later |

## Scope

**In scope:** tag-based carousel validator; deck migration; ranking finance/law flag + eval; section-aware
renderer with photo rotation; text-fit ladders; preview command; 4:5 approval page; docs; real run; deploy.

**Out of scope:** single-post deck changes; statistics on carousel slides; date on cover; per-section
carousels; database migrations; generation prompt changes; Slides layout restructuring.

## Architecture / Approach

Pure modules decide everything up front — tag parsing (`template.ts`), section + photo choice
(`sections.ts`), text sizes (`fit.ts`) — and `render.ts` only composes them with the existing
duplicate → fill → export → delete loop. The cover is exported directly. Failure posture is unchanged.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Commit redesign | Pending dashboard work committed separately | None — already passes checks |
| 2. Deck contract | Validator understands tags, sections, 4:5, shared box | Over-strict rules blocking harmless deck edits |
| 3. Deck migration | 20 story slides use one shared box | Visual spacing differs from operator's eye |
| 4. Finance/law flag | Ranking flag, eval, shortlist badge | Eval regression on tier while adding the flag |
| 5. Renderer | Section-aware weekly carousel | Text-fit tiers mis-calibrated for real copy |
| 6. Preview + 4:5 UI | Preview PNGs; approval page shows 4:5 | — |
| 7. Real run + deploy | Proven on real data, then shipped | Pi/Cloudflare deploy steps not yet verified end to end |

**Prerequisites:** fix the three `###` lines in `.env` (workers refuse to start otherwise).
**Estimated effort:** ~2–3 sessions.

## Open Risks & Assumptions

- Assumes the operator won't add slides without tags; the validator fails loudly if they do.
- The scheduled-publishing change is still marked `implementing`; this plan doesn't touch its code.
- Older digests (no flag) only use Barcelona/Spain slides.

## Success Criteria (Summary)

- The validator passes on both decks, and the preview shows every slide readable with no overflow.
- A real week's carousel reaches the approval page with varied sections and correct text.
- The dashboard and Pi worker run the new version after deploy.
