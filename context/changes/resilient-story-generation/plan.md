# Resilient Story Generation Implementation Plan

## Overview

Make the generation stage robust to article choice. The FR-014 numeric gate changes from "every
figure in the article must be in the copy" to "the copy may only contain figures that exist in the
source, and the headline/lead figures must be present", and a story that still cannot pass after
its corrective retry is left out of the week instead of failing it.

## Current State Analysis

- `generateStory` (`src/lib/generation/generate.ts:176`) extracts every significant figure from the
  fetched article and requires all of them in the output (`assertFiguresPresent`,
  `src/lib/generation/numerals.ts:266`). One corrective retry, then the story fails.
- `generateDigest` (`generate.ts:268`) fails the whole digest on the first failing story.
- Nothing checks that figures in the OUTPUT exist in the source: an invented or rounded number
  passes as long as every source figure is also present.
- Real failure, 2026-10-31: digest `e0e4a533` (week 2026-10-26) failed twice on a mortgage-rate
  table article — 7, then 5 body figures missing, though its headline figure (3,08%) was carried.

## Desired End State

- Copy containing a figure that is not in the source (value-matched, any number in the source
  counts) fails the story's check; so does copy missing a figure from the story's headline or lede.
- One corrective retry names both kinds of problem.
- A story that still fails — the check, a refusal, malformed/truncated output, context overflow —
  is left out; the week continues if at least `MIN_PICKS` (2) stories remain, else it fails as today.
  Cost ceiling and `not_configured` still fail the week at once. `api_error` (incl. timeouts) leaves
  the story out — revised 2026-11-01 after this week's figure-dense story timed out three times; a
  real outage still fails the week because every story errors and fewer than `MIN_PICKS` remain.
- The approval page lists picked stories that were left out under "Not included".
- Verified on the real 2026-10-26 digest: `npm run generate -- --digest=e0e4a533…` reaches `rendering`.

### Key Discoveries:

- `extractFigures` only returns qualified figures (currency/percent/magnitude); comparing output
  figures against those alone would flag legitimate rewording ("0,5 puntos" → "0,5 punktu
  procentowego"), so the invented-figure check compares against every number in the source.
- `PickedStory` already carries `title` and `lede` (`generate.ts:112-121`).
- `renderDigest` already works from the persisted copy rows and checks `MIN_PICKS`
  (`src/lib/visuals/render.ts`), so dropped stories need no rendering change.

## What We're NOT Doing

- No automatic replacement of a dropped story with an unpicked one — the operator chooses.
- No database migration: "Not included" is derived from picked selection items without copy.
- No change to the generation prompt or the carousel/visuals code.
- No change to the cost ceiling or retry count.

## Implementation Approach

Two independent checks in `numerals.ts` (pure, unit-tested), composed in `generateStory`; the drop
decision lives in `generateDigest` and keys off a typed failure kind so infrastructure failures can
never be silently swallowed.

## Phase 1: Number check — no invented figures, key figures present

### Changes Required:

#### 1. Numerals

**File**: `src/lib/generation/numerals.ts`

**Intent**: Add the invented-figure check and the source number pool it compares against.

**Contract**: `sourceValues(text): number[]` — every number in the text, both scaled and unscaled
for magnitude words; `assertNoInventedFigures(sourceText, output): { ok: true } | { ok: false;
invented: Figure[] }`; `describeInvented(figures)`. Existing functions unchanged.

#### 2. Story check

**File**: `src/lib/generation/generate.ts`

**Intent**: Required figures = figures in the story's title + lede; the check passes only when none
are missing and nothing is invented. The retry correction names both lists.

**Contract**: failure message `numeric integrity failed for "<title>" after a corrective retry;
missing …; invented …`.

### Success Criteria:

#### Automated Verification:

- Numerals unit tests (invented, rewording, magnitudes, ranges, empty) pass: `npx vitest run src/lib/generation/numerals.test.ts`
- Generation integration tests pass: `SUPABASE_TEST_PROJECT=1 npx vitest run src/lib/generation/generate.test.ts`
- Full suite, lint, build pass

---

## Phase 2: Per-story safety net and "Not included"

### Changes Required:

#### 1. Drop instead of fail

**File**: `src/lib/generation/generate.ts`, `src/worker/generate.ts`

**Intent**: `generateStory` returns a failure kind (`story` vs `infrastructure`); `generateDigest`
drops `story` failures, fails on `infrastructure`, and fails if fewer than `MIN_PICKS` stories
remain. The outcome reports dropped stories; the worker prints them.

**Contract**: `GenerateOutcome.dropped: { clusterId, title, reason }[]`.

#### 2. Approval page

**File**: `src/pages/dashboard/[id]/approve.astro`

**Intent**: Picked stories without a copy row are listed in a "Not included" notice with a plain
reason ("its copy didn't pass the number check or couldn't be generated").

### Success Criteria:

#### Automated Verification:

- Generation integration tests for drop / too-few-left / infrastructure-still-fails pass
- Full suite, lint, build pass

#### Manual Verification:

- Real digest `e0e4a533` generates and renders; approval page shows the carousel and any "Not included" story

---

## Phase 3: Docs

### Changes Required:

**Files**: `context/foundation/prd.md` (FR-014 wording), `CLAUDE.md` (`npm run generate` description)

**Intent**: Record the operator's 2026-10-31 decision so the requirement and the code agree.

### Success Criteria:

#### Automated Verification:

- Lint and format pass

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Number check — no invented figures, key figures present

#### Automated

- [x] 1.1 Numerals unit tests pass — c0f7aa1
- [x] 1.2 Generation integration tests pass — c0f7aa1
- [x] 1.3 Full suite, lint, build pass — c0f7aa1

### Phase 2: Per-story safety net and "Not included"

#### Automated

- [x] 2.1 Generation integration tests for drop / too-few-left / infrastructure-still-fails pass
- [x] 2.2 Full suite, lint, build pass

#### Manual

- [x] 2.3 Real digest generates and renders; approval page shows the carousel and any "Not included" story

### Phase 3: Docs

#### Automated

- [x] 3.1 Lint and format pass
