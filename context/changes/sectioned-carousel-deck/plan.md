# Sectioned Carousel Deck Implementation Plan

## Overview

The operator redesigned the carousel template deck: one weekly cover plus 20 story slides split into three
visual sections — Barcelona, Hiszpania (Spain), and "Ceny, kredyty, podatki i prawo" (finance/law) — at
1080×1350 (4:5). This plan teaches the pipeline to render one combined weekly carousel from that deck: each
story lands on a photo slide from a section it belongs to, chosen for visual variety, with the title and a
short description filled in. The single-post deck keeps its current contract untouched.

## Current State Analysis

- The deck contract (`src/lib/visuals/template.ts:56-67`) is positional: carousel = exactly 2 slides
  (cover with `{{COVER_TITLE}}`/`{{COVER_SUBTITLE}}`, story with `{{TITLE}}` + 3 statistic pairs), square page.
  The redesigned deck fails `npm run visuals:validate` on page size, slide count and placeholders (verified
  2026-10-31).
- `renderDigest` (`src/lib/visuals/render.ts:413`) locates templates by position (`resolveTemplates`,
  `render.ts:166`), duplicates one story template per story, fills it by `replaceAllText` scoped to the
  page, sizes the title by a character-count ladder (`src/lib/visuals/fit.ts:33`), exports, deletes.
- `buildSlotMap` (`src/lib/visuals/slots.ts:79`) fails a story with fewer than 3 usable statistics — correct
  for single-post, wrong for the new carousel design, which has no statistic slots.
- Ranking already persists each cluster's whole `ClusterScore` (`tier`, `topics`, `score`, `rationale`) into
  `cluster.scoring_detail` jsonb (`src/lib/ranking/rank.ts:119-131`), so a new schema field flows to the
  database with no migration. `tier` already decides geography: `catalonia` → Barcelona, `national`/`global`
  → Spain.
- The approval page renders assets as `aspect-square` (`src/components/AssetStrip.astro:34-43`).
- **The deck itself (state on 2026-10-31):** 21 slides at 1080×1350. Slide 1 is the only cover — fixed text,
  no placeholders, speaker notes `role=cover`. Slides 2–9 notes `section=barcelona role=story`, 10–15
  `section=spain role=story`, 16–21 `section=finance_law role=story`. Each story slide has `{{TITLE}}`
  (722×52 px box, Arial 32 pt) and `{{DESCRIPTION}}` (743×35 px box, Arial 22 pt) stacked 63 px apart —
  Slides resets the boxes' "resize to fit" on any API text replacement, so a wrapped title would overlap the
  description.
- `.env` currently stops every worker at startup: `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORGANIZATION_URN` and
  `HEARTBEAT_PING_URL` are `###`, which Node's `--env-file` reads as a comment (empty / invalid URL).

## Desired End State

- `npm run visuals:validate` passes on the redesigned carousel deck and still passes on the single-post deck.
- A weekly carousel is: the cover slide, then one slide per picked story in shortlist order; each story's
  slide comes from a section it fits, with title and description in one shared text box that never
  overflows (or the run stops with a diagnostic naming the story and its character count).
- The shortlist shows a "Ceny/prawo" badge on stories ranking flagged as finance/law.
- `npm run visuals:preview` writes PNGs of every story slide and the cover, filled with sample stories, to a
  local folder, with no database or Storage writes.
- The approval page shows 4:5 slides without letterboxing.
- Verified by: unit tests, `RANKING_EVAL=1 npm test`, the validator, the preview, and one real weekly run
  that reaches the approval page.

### Key Discoveries:

- `cluster.scoring_detail` stores the full parsed score — adding `financeLaw` to `clusterScoreSchema`
  (`src/lib/ranking/score.ts:40`) needs no migration; old rows simply lack the field.
- The rubric is eval-gated: any change to `src/lib/ranking/rubric.ts` must pass `RANKING_EVAL=1 npm test`
  (CLAUDE.md), and its labeled set is held out of the prompt.
- Slides `duplicateObject` copies speaker notes, and `objectIds` lets the duplicate's text box get a
  deterministic id (`render.ts:263-267`) — the shared box keeps that mechanism.
- The cover has nothing to fill, so it can be exported directly from the template page — no duplicate.
- `caption_summary` (one or two sentences, `src/lib/generation/prompt.ts:96`) is the description source; it
  already passes the numeric-integrity gate.

## What We're NOT Doing

- No change to the single-post deck, its validator rules, or its rendering path (operator reworks it later).
- No date range on the cover; no statistics on carousel slides (still generated and archived).
- No one-carousel-per-section output; no story rendered twice.
- No new database column or migration.
- No change to generation prompts or the carousel `body_copy` slides.
- No Slides layouts / theme-builder restructuring of the deck.
- No changes to the scheduled-publishing change's code beyond what 4:5 images require (none found).

## Implementation Approach

Make the carousel deck contract tag-based instead of positional, migrate the 20 story slides to the shared
title/description box, add the finance/law flag at ranking time, then replace the carousel half of the
renderer with a section-aware planner. Pure decisions (tag parsing, section choice, photo rotation, text fit)
live in small pure modules with unit tests; the renderer only composes them, keeping the existing failure
posture (genuine problem → `failed` + diagnostic; infrastructure → raw error, digest left in `rendering`).

## Critical Implementation Details

**Text indexes in the shared box.** After `replaceAllText`, the box holds `title + "\n" + description`.
Per-paragraph font sizes are applied with `updateTextStyle` on `FIXED_RANGE`s computed in UTF-16 code units
(JS `.length`, matching the Slides API), in the same batch, *after* the two replacements. Style the
description range from `title.length + 1` to the end; the title range `[0, title.length)`.

**Section choice is order-dependent.** Assign sections walking stories in shortlist rank order; "fewer so
far" counts slides already assigned in this carousel. Equal counts → the story's geography section.

## Phase 1: Commit the pending dashboard redesign

### Overview

The working tree holds an uncommitted dashboard redesign (new `AppHeader`, `StatusChip`, `Notice`,
`ConfirmDialog`, `presentation.ts`, deleted `Topbar`/`Welcome`/`index.astro`, etc.). It passes tests, lint
and build (2026-10-31). Commit it on its own so this change's commits stay reviewable.

### Changes Required:

#### 1. Redesign commit

**File**: working tree (all currently modified/untracked files listed by `git status`)

**Intent**: One conventional commit (`feat(dashboard): …`) on a feature branch, before any change for this plan.

**Contract**: No code edits; branch `sectioned-carousel-deck` created from `main`.

### Success Criteria:

#### Automated Verification:

- Tests pass: `npm test`
- Lint passes with 0 errors: `npm run lint`
- Build passes: `npm run build`

---

## Phase 2: Tag-based carousel deck contract and validator

### Overview

Define the new carousel deck contract and make `npm run visuals:validate` check it; single-post stays as is.

### Changes Required:

#### 1. Slides client types

**File**: `src/lib/visuals/slides-client.ts`

**Intent**: Expose what the new contract reads: each slide's speaker-notes text and each element's size.

**Contract**: `Slide` gains optional `slideProperties.notesPage` (`notesProperties.speakerNotesObjectId`,
`pageElements`); `PageElement` gains optional `size`/`transform`. Wire shape stays the raw API response.

#### 2. Contract + validator

**File**: `src/lib/visuals/template.ts`

**Intent**: Carousel decks are described by tags, not positions. Keep the single-post spec and its checks.

**Contract**:
- `CAROUSEL_SECTIONS = ["barcelona", "spain", "finance_law"] as const`; `parseSlideTag(notes)` →
  `{ role: "cover" } | { role: "story"; section } | null` (tokens `key=value`, order-free, whitespace-tolerant).
- Story placeholders for the carousel: `TITLE`, `DESCRIPTION`; they must share exactly one text box, title
  first. Cover: no placeholders.
- Fatal: page not 4:5 (±2%); not exactly one cover; a slide with no/unknown tag; a section with no story
  slide; missing/duplicated/unknown placeholder; `TITLE`/`DESCRIPTION` not in the same box, or that box
  holding anything else. Warning: 4:5 but not 1080 px wide.
- `validateDeck("single_post", …)` behaviour unchanged (existing tests stay green).

#### 3. Validator entrypoint + spec document

**Files**: `src/worker/validate-decks.ts`, new `context/foundation/slides-template-spec.md`

**Intent**: Point failures at a spec path that will not go stale on archive (the current message points at
the archived `context/changes/brand-visual-assets/template-spec.md`). The spec documents both decks:
tags, sections, the shared box, 4:5, sharing.

**Contract**: Human doc; validator message references the new path. `template.ts`'s header comment updated.

### Success Criteria:

#### Automated Verification:

- Unit tests for tag parsing and every fatal/warning rule pass: `npx vitest run src/lib/visuals/template.test.ts`
- Full suite, lint, build pass: `npm test`, `npm run lint`, `npm run build`

---

## Phase 3: Migrate the deck's story slides to the shared box

### Overview

One-off API edit of the operator's carousel deck (approved 2026-10-31): on all 20 story slides, move
`{{DESCRIPTION}}` into the `{{TITLE}}` box as a second paragraph and remove the old description box.

### Changes Required:

#### 1. One-off migration script (not committed)

**File**: scratchpad script using `createSlidesClient`

**Intent**: Per story slide, in one atomic batch: append `"\n{{DESCRIPTION}}"` to the title box with the
description's original style (Arial ~22 pt, regular, same colour); delete the description box; set the
title box's height so its bottom sits just above the panel's divider line (box keeps its top-left and
width). Refuse to run if any story slide's layout differs from the measured one.

**Contract**: Touches only the 20 `role=story` slides; cover untouched; before/after thumbnails saved.

### Success Criteria:

#### Automated Verification:

- `npm run visuals:validate` passes for both decks (with the `.env` placeholders fixed — see Prerequisites)

#### Manual Verification:

- Operator reviews before/after thumbnails of the 20 slides and confirms the look

---

## Phase 4: Finance/law flag in ranking

### Overview

Ranking adds a yes/no `financeLaw` judgment per story, shown on the shortlist.

### Changes Required:

#### 1. Score schema + rubric

**Files**: `src/lib/ranking/score.ts`, `src/lib/ranking/rubric.ts`

**Intent**: `financeLaw: true` when the story's core is prices, mortgages/loans, taxes or housing law/
regulation — independent of tier. Off-topic (`discard`) stories are always `false`.

**Contract**: `clusterScoreSchema` gains `financeLaw: z.boolean()`. Persisted automatically into
`scoring_detail`. Readers treat a missing field (pre-change rows) as `false`.

#### 2. Eval

**Files**: `src/lib/ranking/eval/examples.ts`, `src/lib/ranking/eval/harness.ts`

**Intent**: Each labeled example gets `expectedFinanceLaw`; the harness reports a `financeLawFailures` list
and `passed` requires it empty.

**Contract**: `LabeledExample.expectedFinanceLaw: boolean`; `EvalReport.financeLawFailures`.

#### 3. Shortlist badge

**Files**: `src/types.ts` (`ShortlistItem.financeLaw: boolean`), `src/pages/dashboard/[id].astro`,
`src/components/ShortlistCard.tsx`

**Intent**: A small "Ceny/prawo" badge next to the tier badge so the operator sees the section mix when picking.

**Contract**: Read from `scoring_detail.financeLaw`, default `false`.

### Success Criteria:

#### Automated Verification:

- Unit tests (schema, harness, shortlist mapping) pass: `npm test`
- Ranking eval passes with the real rubric: `RANKING_EVAL=1 npm test`
- Lint, build pass: `npm run lint`, `npm run build`

#### Manual Verification:

- Operator confirms the `expectedFinanceLaw` labels on the held-out examples before the eval is trusted

---

## Phase 5: Section-aware carousel rendering

### Overview

Replace the carousel half of `renderDigest` with a planner that picks the cover and one tagged photo slide
per story, fills the shared box, and sizes both paragraphs.

### Changes Required:

#### 1. Section assignment (pure)

**File**: new `src/lib/visuals/sections.ts`

**Intent**: Decide each story's section and photo slide.

**Contract**:
- `storySections(detail)`: geography section from tier (`catalonia` → barcelona; `national`/`global` →
  spain); plus `finance_law` when `financeLaw`. A story with no geography section (`discard` or missing
  detail) → `finance_law` if flagged, else `spain`.
- `assignSlides(stories in rank order, deckStorySlidesBySection, weekSeed)`: one section per story — the
  candidate with the fewest slides assigned so far; tie → geography section. Within a section, photos are
  taken in deck order starting at `weekSeed % count`, never repeating within a carousel until the section's
  photos are exhausted, then cycling.
- `weekSeed` = ISO week number of `digest.window_start`.

#### 2. Text fit for the shared box

**File**: `src/lib/visuals/fit.ts`

**Intent**: Add a description ladder beside the title ladder, recalibrated to the new box (title ~34 chars
per line at 32 pt; description ~51 chars per line at 22 pt); past the last tier → failure naming the story
and character count.

**Contract**: `CAROUSEL_TITLE_TIERS`, `DESCRIPTION_TIERS`, `fitCarouselText(title, description)` →
`VisualResult<{ titlePt, descriptionPt }>`. Existing `TITLE_SIZE_TIERS`/`fitTitle` untouched (single-post).

#### 3. Slots + renderer

**Files**: `src/lib/visuals/slots.ts`, `src/lib/visuals/render.ts`

**Intent**: Carousel slots are `{ TITLE: polish_title, DESCRIPTION: caption_summary }` — no statistics
requirement. `fetchRenderInput` also reads each cluster's `scoring_detail`. For `carousel`: resolve
templates by tag, export the cover page directly (no duplicate), then per story duplicate its assigned
slide, replace both tokens, apply the two range font sizes, export, delete. Single-post path unchanged.
`generated_asset` rows unchanged in shape (`slide_index` 0 = cover).

**Contract**: `PagePlan` for carousel story pages carries `{ templatePageId, boxElementId, titlePt,
descriptionPt, slots }`; cover plan has no duplication. Leftover sweep, retry, and cleanup semantics as today.

### Success Criteria:

#### Automated Verification:

- Unit tests pass for: section choice incl. tie → geography, a two-section story choosing the scarcer
  section, a `discard`/missing-detail story, photo rotation by week seed with no repeats in one carousel,
  cycling when a section has fewer photos than stories, text-fit ladders and over-length failure, UTF-16
  range math with Polish diacritics, carousel request batch shape, cover exported without duplication:
  `npx vitest run src/lib/visuals`
- Single-post render tests unchanged and green: `npm test`
- Lint, build pass

---

## Phase 6: Preview command and 4:5 approval page

### Overview

Give the operator a no-side-effect way to see every slide, and show 4:5 assets correctly.

### Changes Required:

#### 1. Preview entrypoint

**Files**: new `src/worker/visuals-preview.ts`, `package.json` (`visuals:preview`), `.gitignore`

**Intent**: Fill the cover and every story slide of the carousel deck with built-in sample stories (short,
typical, longest-allowed title/description, Polish diacritics) and save PNGs to `visuals-preview/`. Uses
the same duplicate/fill/export/delete code as the renderer; no database, no Storage.

**Contract**: Exits 2 on missing credentials/deck id (same refusal style as `validate-decks.ts`); 1 if any
slide fails; prints the output folder.

#### 2. Approval page aspect

**File**: `src/components/AssetStrip.astro` (+ `RenderedAsset` gets `width`/`height` from `generated_asset`)

**Intent**: Size each image from its stored dimensions instead of `aspect-square`.

**Contract**: `RenderedAsset.width`, `RenderedAsset.height`; callers in `dashboard/[id].astro` and
`approve.astro` pass them.

#### 3. Docs

**File**: `CLAUDE.md`

**Intent**: Document `npm run visuals:preview` and the tag-based carousel contract next to `visuals:validate`.

### Success Criteria:

#### Automated Verification:

- `npm run visuals:preview` writes 21 PNGs (1 cover + 20 stories), all 1080×1350-proportioned
- Tests, lint, build pass

#### Manual Verification:

- Operator reviews the preview PNGs: no overflow, longest sample still readable on a phone

---

## Phase 7: Real run, then deploy

### Overview

Prove the full flow on real data, then ship after explicit go-ahead.

### Changes Required:

#### 1. Real weekly run

**Intent**: A fresh digest with the new flag: `npm run collect -- --week=<a recent Monday>` → `npm run rank`
→ operator picks 3–4 stories (carousel) on the dashboard → `npm run generate` → `npm run visuals` →
approval page. Costs cents of LLM spend.

#### 2. Deploy (each step only after the operator says go)

**Intent**: Push the branch and open a PR (CI runs lint + build); merge; `npx wrangler deploy` for the
dashboard; on the Raspberry Pi, `git pull` + `npm ci` so the scheduled worker picks up the change.

### Success Criteria:

#### Automated Verification:

- CI green on the PR

#### Manual Verification:

- The real digest's carousel on the approval page shows the cover then one slide per story, sections
  varied, text inside the panel
- Production dashboard loads after `wrangler deploy`
- Pi's next scheduled run (or a manual `npm run visuals -- --digest=<uuid>` there) renders with the new deck

---

## Testing Strategy

### Unit Tests:

- `template.test.ts`: tag parsing; every fatal/warning rule; single-post unchanged.
- `sections.test.ts`: assignment and rotation cases listed in Phase 5.
- `fit.test.ts`: new ladders, boundaries, over-length.
- `render.test.ts`: carousel plan + batch with faked transport; cover not duplicated; failure posture.
- `score.test.ts` / harness tests: `financeLaw` parse and failure reporting.

### Integration Tests:

- `RANKING_EVAL=1 npm test` (real rubric, cents).
- `npm run visuals:validate` and `npm run visuals:preview` against the real deck.

### Manual Testing Steps:

1. Review Phase 3 before/after thumbnails.
2. Review `visuals-preview/` PNGs.
3. Run the Phase 7 weekly flow and check the approval page on a phone-width window.

## Migration Notes

- No database migration. Clusters ranked before this change have no `financeLaw` → treated as `false`, so
  their stories only use Barcelona/Spain slides.
- The deck migration (Phase 3) is reversible through Slides version history.

## Prerequisites

- `.env`: comment out or fill `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORGANIZATION_URN`, `HEARTBEAT_PING_URL`
  (currently `###`), or every worker refuses to start.

## References

- Deck dump and thumbnails (2026-10-31): scratchpad `decks-now/`
- Prior contract: `context/archive/2026-09-08-brand-visual-assets/template-spec.md`
- Renderer: `src/lib/visuals/render.ts:413`; slot map `src/lib/visuals/slots.ts:79`; fit `src/lib/visuals/fit.ts:33`
- Ranking persistence: `src/lib/ranking/rank.ts:119-131`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Commit the pending dashboard redesign

#### Automated

- [x] 1.1 Tests pass: `npm test` — b34f9d9
- [x] 1.2 Lint passes with 0 errors: `npm run lint` — b34f9d9
- [x] 1.3 Build passes: `npm run build` — b34f9d9

### Phase 2: Tag-based carousel deck contract and validator

#### Automated

- [x] 2.1 Unit tests for tag parsing and every fatal/warning rule pass — f7a21db
- [x] 2.2 Full suite, lint, build pass — f7a21db

### Phase 3: Migrate the deck's story slides to the shared box

#### Automated

- [x] 3.1 `npm run visuals:validate` passes for both decks — 9c2e560

#### Manual

- [x] 3.2 Operator reviews before/after thumbnails of the 20 slides and confirms the look — 9c2e560

### Phase 4: Finance/law flag in ranking

#### Automated

- [x] 4.1 Unit tests (schema, harness, shortlist mapping) pass — b0c6aaf
- [x] 4.2 Ranking eval passes with the real rubric: `RANKING_EVAL=1 npm test` — b0c6aaf
- [x] 4.3 Lint, build pass — b0c6aaf

#### Manual

- [x] 4.4 Operator confirms the `expectedFinanceLaw` labels on the held-out examples — b0c6aaf

### Phase 5: Section-aware carousel rendering

#### Automated

- [x] 5.1 Section, rotation, fit, range-math and batch-shape unit tests pass — 54571dc
- [x] 5.2 Single-post render tests unchanged and green — 54571dc
- [x] 5.3 Lint, build pass — 54571dc

### Phase 6: Preview command and 4:5 approval page

#### Automated

- [x] 6.1 `npm run visuals:preview` writes 21 PNGs at 4:5
- [x] 6.2 Tests, lint, build pass

#### Manual

- [x] 6.3 Operator reviews the preview PNGs

### Phase 7: Real run, then deploy

#### Automated

- [ ] 7.1 CI green on the PR

#### Manual

- [ ] 7.2 Real digest's carousel on the approval page is correct
- [ ] 7.3 Production dashboard loads after `wrangler deploy`
- [ ] 7.4 Pi renders with the new deck
