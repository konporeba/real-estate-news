# Archive & Learning Loop (S-09) Implementation Plan

## Overview

S-09 closes the last gap between "a digest has full-fidelity editorial data" and "the operator can
see it and the rubric learns from it." It has two parts that share one storage shape
(`selection_item`, built by S-04 specifically for this): (1) surfacing the rubric's own reasoning
(score + rationale) on the shortlist view that already renders picks and passes, plus paginating
the digest list so history beyond the last 25 weeks is reachable; and (2) feeding each week's
picks-vs-passes back into the geography rubric as capped, eval-safe few-shot examples, so ranking
converges on the operator's actual taste (FR-025) rather than staying purely zero-shot forever.

## Current State Analysis

Direct reading of the code turned up more already-built than the roadmap entry suggested:

- **`dashboard/[id].astro` already renders the full 15-item shortlist — picks AND passes —
  whenever a digest has moved past `ranking` and isn't `failed`** (`src/pages/dashboard/[id].astro:56-134,344-348`).
  `shortlist` comes from every ranked `cluster` row, not just picked ones; `pickedClusterIds`
  (from `selection_item.eq("picked", true)`, line 154-158) only decides which cards get the
  "selected" badge via `<ShortlistCard item={item} picked={pickedClusterIds.has(item.clusterId)} />`.
  **The only real gap: `ShortlistItem` and `ShortlistCard` expose `tier` but not `score` or
  `rationale`**, even though both are already stored in `cluster.scoring_detail` jsonb
  (`src/lib/ranking/score.ts:40-48`).
- **`dashboard/[id]/approve.astro` already renders full-fidelity, read-only content for any
  terminal-status digest** — generated copy, key statistics, source fact-check, rendered visuals
  (`AssetStrip.astro`), and per-platform publish results (`PublicationResults.astro`) — with zero
  hydrated islands once a digest is `published`/`rejected`/`skipped`. This is effectively already
  the archive detail view FR-024 asks for; nothing here needs to change.
- **`selection_item` already stores exactly what FR-025 needs**, and was built anticipating this
  slice: one row per shortlisted cluster (all 15, not just picks), `picked boolean` as the label
  (`supabase/migrations/20260829120000_selection_gate.sql:50-62`). The migration's own comment:
  "S-09 (archive-and-learning-loop) consumes them as few-shot material to converge the ranking
  rubric on the operator's real editorial taste." An index on `cluster_id`
  (`supabase/migrations/20260906140000_selection_item_indexes.sql`) exists for the same reason.
  **No new table is needed** — `feedback_label`, named in early foundation docs, was never built;
  S-04 shipped `selection_item` instead and that is what this plan reads from.
- **The rubric is zero-shot by explicit design today**, with a load-bearing written constraint:
  `src/lib/ranking/rubric.ts:1-4` — "the held-out eval set never appears here, so the eval
  measures generalization, not memorization (any future few-shot, from S-09, must also be
  disjoint from the eval set)." `GEOGRAPHY_RUBRIC_SYSTEM` (lines 14-36) is a flat template string
  passed with `cacheSystem: true` from `score-clusters.ts:117-119`.
- **`dashboard.astro` is the only list page in the app**, a flat `.limit(25)` with no pagination
  and no status filtering (`src/pages/dashboard.astro:8-16`). It already shows every digest
  regardless of status — extending it is a matter of adding pagination and a filter, not building
  a second view.
- **Archive visual assets live in Supabase Storage (a cloud service), not the Pi's local disk** —
  the roadmap's OQ#5 wording ("local disk on the Pi") is stale, carried over from before S-06
  settled on Supabase Storage specifically because it's reachable regardless of where the app
  runs (`context/archive/2026-09-08-brand-visual-assets/plan-brief.md:38`). No expiry/cleanup
  logic exists anywhere in `generated_asset`/the bucket config. Per-digest footprint is small
  (order of 1-2MB of images/week), and the operator has chosen to keep everything indefinitely —
  this plan resolves OQ#5 with no code change.
- **`publication` keeps only the latest attempt per platform** (unique on `(digest_id, platform)`,
  upserted by `record_publication()`), not a full retry log
  (`supabase/migrations/20260913120000_publication.sql:39-52`). The operator has confirmed this is
  sufficient for archive purposes — no schema change here either.

### Key Discoveries:

- `src/lib/ranking/eval/examples.ts` — the 16 hand-labeled `EVAL_EXAMPLES` and their
  `EXPECTED_ORDERINGS`, which any few-shot content must never overlap.
- `src/lib/ranking/eval/rubric.eval.test.ts` — the opt-in `RANKING_EVAL=1` gate that must keep
  passing after this change; it's the mechanism that makes the learning loop safe to ship at all.
- `src/lib/ranking/score-clusters.ts:104-124` — where `GEOGRAPHY_RUBRIC_SYSTEM` is currently passed
  straight into `invoke()`; this is the one place the few-shot content needs to be spliced in.
- `src/lib/ranking/rank.ts:172-264` (`rankDigest`) — the orchestrator that calls `scoreClusters`;
  this is where fetching few-shot examples needs to be threaded in, gated by a config flag.
- `src/pages/dashboard/[id].astro:105-134` — the exact shape to extend for score/rationale, and the
  representative-article convention to reuse for the few-shot query (`clusterArticles.find((a) =>
  a.polish_title) ?? clusterArticles.at(0)`).
- `src/worker/env.ts` — `z.coerce.boolean()` is a footgun here (any non-empty string, including
  `"0"`, coerces to `true`); the new flag uses the `z.enum(["0","1"])` + transform pattern instead.

## Desired End State

- Any digest that reached the selection gate or later shows, on its existing detail page, every
  shortlisted story's tier, score, and one-line rationale — not just picks/passes.
- The dashboard list can be paged and filtered well beyond the last 25 weeks.
- Real ranking runs, when `RANKING_FEWSHOT_ENABLED` is on, score against a rubric prompt that
  includes a small, recent, capped sample of the operator's actual past picks and passes.
- `RANKING_EVAL=1 npm test` continues to pass, and additionally verifies that whatever few-shot
  content real ranking would use never overlaps the held-out eval set.
- The operator can turn the few-shot mechanism off with one config change if it ever looks like
  it's degrading rankings, with no deploy required to do so.
- Roadmap OQ#5 (retention) is marked resolved: keep everything indefinitely.

**Verification**: browse an old digest end to end (shortlist with scores/rationale → generated
copy → visuals → publish results, all on the existing pages); page through more than 25 digests
on the list; run `RANKING_EVAL=1 npm test` and confirm it's green with real few-shot content
wired in; confirm via `cacheReadTokens`/`cacheCreationTokens` that the extended system prompt
still caches.

## What We're NOT Doing

- No new table for curating/reviewing few-shot examples before use — they're read directly from
  `selection_item`, per the operator's own confirmed preference.
- No retry-history schema for `publication` — latest-per-platform stays as is.
- No image expiry/cleanup job — retention is "keep everything," resolving OQ#5 as-is.
- No new archive route — the existing `dashboard.astro` (list), `dashboard/[id].astro`
  (shortlist detail), and `dashboard/[id]/approve.astro` (generated content + results) together
  already constitute the archive; this plan extends them rather than forking a parallel view.
- No live smoke test for the archive queries — they're plain internal Postgres reads with no
  third-party behavior to catch drifting, unlike the existing RSS/Slides/Gmail/Anthropic smoke
  tests.
- No automatic runtime disabling of the few-shot mechanism on eval failure — `RANKING_EVAL` is a
  manual pre-ship gate, not a live monitor, so there is nothing at real ranking time to trigger an
  auto-disable against.

## Implementation Approach

Two independent tracks sharing one data source (`selection_item`):

1. **Archive visibility** (Phases 1-2): small, additive changes to already-working pages. No new
   routes, no new tables, no new tests beyond typecheck/lint — this is exposing data that is
   already captured.
2. **Learning loop** (Phases 3-5): a new read path over `selection_item` (Phase 3), wired into the
   rubric's system prompt behind a kill-switch (Phase 4), with a mechanically-enforced safety
   guarantee that it can never leak into the held-out eval set (Phase 5) — because that guarantee
   is what makes shipping a mechanism that changes ranking behavior responsible at all.

Phase 6 verifies both tracks together and closes the roadmap's open question.

## Critical Implementation Details

**Eval-set safety is the one place this plan cannot get away with "add a comment and hope."**
`rubric.ts`'s own header already promises few-shot content stays disjoint from `EVAL_EXAMPLES`;
Phase 5's checker must run against the *real* few-shot query result inside the `RANKING_EVAL`
gate (not just synthetic test fixtures), because the actual risk is a real collected article's
title one day textually matching one of the 16 hand-written eval examples. A unit test on
synthetic data proves the checker works; only running it against live query output inside
`rubric.eval.test.ts` proves the guarantee holds in practice.

**Ordering matters for cache economics.** `scoreClusters` batches concurrently
(`MAX_CONCURRENCY = 3`, `score-clusters.ts:22`), but every batch within one `rankDigest` call must
receive the *same* few-shot set for `cacheSystem: true` to pay off within that run — fetch the
few-shot examples once per `rankDigest` call, not once per batch.

## Phase 1: Surface score + rationale on shortlist cards

### Overview

Close the one real gap in the already-working picks/passes view: `tier` is shown today, `score`
and `rationale` are captured but not surfaced.

### Changes Required:

#### 1. `ShortlistItem` type

**File**: `src/types.ts`

**Intent**: Add the two fields already computed by the rubric but not yet exposed to the view
layer.

**Contract**: Extend the `ShortlistItem` interface (`src/types.ts:99-114`) with `score: number |
null` and `rationale: string | null`, alongside the existing `tier: string | null`.

#### 2. Shortlist detail query

**File**: `src/pages/dashboard/[id].astro`

**Intent**: Extract `score` and `rationale` from `cluster.scoring_detail` the same way `tier`
already is.

**Contract**: In the `shortlist` build (`src/pages/dashboard/[id].astro:105-134`), widen the cast
at line 118 from `{ tier?: string }` to also read `score` and `rationale`, and add both to the
returned `ShortlistItem` object.

#### 3. Shortlist card rendering

**File**: `src/components/ShortlistCard.tsx`

**Intent**: Show the score and rationale next to the existing tier badge, in all three modes
(plain, selectable, picked) since they share one component.

**Contract**: Render `item.score` alongside the tier badge (e.g. `{item.tier} · {item.score}`)
and `item.rationale` as a small caption line beneath it, following the existing muted-text
styling used for the coverage-count line (`ShortlistCard.tsx:110-120`). Render nothing when
either is `null` (pre-S-09 clusters, or a discard with no useful rationale) — no placeholder text.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Full test suite passes: `npm test`

#### Manual Verification:

- Open a digest with a confirmed selection: every one of the 15 cards shows tier, score, and a
  one-line rationale; picked cards keep their "selected" badge, passed cards render exactly as
  before plus the new fields.
- A pre-S-09 digest (if one exists without `scoring_detail`) renders with no crash and no
  placeholder text where score/rationale would go.

---

## Phase 2: Archive list — pagination + status filter

### Overview

`dashboard.astro`'s flat `.limit(25)` currently hides any digest older than ~6 months. Extend it
so the full history is reachable.

### Changes Required:

#### 1. Digest list page

**File**: `src/pages/dashboard.astro`

**Intent**: Let the operator page backward through history, and narrow the view to digests that
have actually reached a state worth reviewing (vs. ones still in flight).

**Contract**: Add keyset pagination on `window_start` — an optional `?before=<window_start>`
query param that adds `.lt("window_start", before)` to the existing query
(`src/pages/dashboard.astro:12-16`), with an "Older →" link rendered when a full page (25) comes
back, carrying the last row's `window_start` forward. Add a simple status filter (e.g. a
`?view=active|all` toggle, default `all` preserving today's behavior) where `active` narrows to
`status in ('collecting','ranking','ready_for_selection')` — the "needs my attention now" set —
so the operator can distinguish "what's in flight" from "everything," without losing the
unfiltered view as the default.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- With more than 25 digests in the database, clicking "Older →" shows the next page and the link
  disappears once the oldest digest is reached.
- The `active` filter shows only in-flight digests; the default view is unchanged from today.

---

## Phase 3: Few-shot example retrieval

### Overview

A new read-only module that turns real `selection_item` history into the shape the rubric prompt
needs — the foundation the next two phases build on.

### Changes Required:

#### 1. Few-shot query module

**File**: `src/lib/ranking/few-shot.ts` (new)

**Intent**: Fetch a small, recent, capped sample of real picks and passes, joined back to the
representative article's original title/lede and the cluster's stored tier/rationale — using the
same representative-article convention already established in `[id].astro` and `rank.ts`
(prefer the article with `polish_title` set, else the first).

**Contract**:

```ts
export interface FewShotExample {
  title: string;
  lede: string | null;
  tier: GeographyTier;
  picked: boolean;
  rationale: string;
}

export async function fetchFewShotExamples(
  client: ServiceClient,
  options: { limitPerLabel: number; excludeDigestId?: string },
): Promise<FewShotExample[]>
```

Query `selection_item` joined to `selection` (for `confirmed_at` ordering and `digest_id`),
`cluster` (`scoring_detail` for tier/score/rationale), and `article` (representative per
cluster). Run two ordered queries — most recent `limitPerLabel` rows where `picked = true`, most
recent `limitPerLabel` where `picked = false`, both ordered by `selection.confirmed_at desc` —
and return them concatenated (picked first, then passed). A cluster whose representative article
lookup fails (defensive only — should not happen for a confirmed selection) is skipped, not
thrown, mirroring the existing `.flatMap`/skip convention in `[id].astro`.

A database error returns `RunStateResult`-shaped failure (`{ ok: false, reason: "database_error",
message }}`), consistent with every other worker-side query in `src/lib/ranking/`.

### Success Criteria:

#### Automated Verification:

- New unit tests pass: `npm test -- few-shot` — cover the picked/passed split, the cap, and the
  ordering (most recent first) against fixture data (a fake `ServiceClient` or Supabase test
  helpers already used elsewhere in `src/lib/ranking/*.test.ts`).
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- None — this phase has no observable behavior on its own; it is not yet wired into ranking.

---

## Phase 4: Wire few-shot into the rubric prompt behind a config flag

### Overview

Splice Phase 3's examples into the rubric's system prompt, threaded through the real ranking run,
behind an instant kill-switch.

### Changes Required:

#### 1. Rubric prompt builder

**File**: `src/lib/ranking/rubric.ts`

**Intent**: Add an optional few-shot section to the rubric without changing its zero-shot
behavior when no examples are supplied.

**Contract**: Add `buildRubricSystemPrompt(fewShot: FewShotExample[]): string`, returning
`GEOGRAPHY_RUBRIC_SYSTEM` unchanged when `fewShot.length === 0`, otherwise
`GEOGRAPHY_RUBRIC_SYSTEM` plus an appended section titled something like "PAST EDITORIAL
DECISIONS" listing each example's title, lede, tier, whether it was picked or passed, and its
rationale — in the same title/lede block style `buildScoringPrompt` already uses
(`rubric.ts:39-47`). Keep `GEOGRAPHY_RUBRIC_SYSTEM` itself exported unchanged, since the eval's
zero-shot baseline callers and the disabled-flag path both still need the bare rubric text.

#### 2. Scoring call sites

**File**: `src/lib/ranking/score-clusters.ts`

**Intent**: Let callers supply few-shot examples without changing the default (zero-shot)
behavior.

**Contract**: Add `fewShotExamples?: FewShotExample[]` to `scoreClusters`'s and `scoreBatch`'s
`options` parameter (default `[]`); replace the hardcoded `system: GEOGRAPHY_RUBRIC_SYSTEM`
(`score-clusters.ts:117`) with `system: buildRubricSystemPrompt(options.fewShotExamples ?? [])`.
`scoreExample` (used by the eval) also gains the same optional parameter, passed through to
`scoreClusters`.

#### 3. Ranking orchestrator

**File**: `src/lib/ranking/rank.ts`

**Intent**: Fetch few-shot examples once per ranking run (not per batch, per the caching note
above) and pass them through, gated by the config flag.

**Contract**: `RankOptions` (`rank.ts:26-28`) gains `fewShot: { enabled: boolean; limitPerLabel:
number }`. In `rankDigest`, immediately before calling `scoreClusters` (`rank.ts:215`), when
`options.fewShot.enabled`, call `fetchFewShotExamples(client, { limitPerLabel:
options.fewShot.limitPerLabel, excludeDigestId: digest.id })` and pass the result into
`scoreClusters`'s options; a fetch failure here fails the digest the same way a scoring failure
does today (via `failDigest`), since ranking without the intended few-shot content would silently
under-deliver on FR-025.

#### 4. Worker configuration

**File**: `src/worker/env.ts`

**Intent**: Give the operator an instant, no-deploy way to revert to zero-shot ranking.

**Contract**: Add `RANKING_FEWSHOT_ENABLED: z.enum(["0", "1"]).default("1").transform((v) => v ===
"1")` — an enum, not `z.coerce.boolean()`, because `z.coerce.boolean()` treats any non-empty
string (including `"0"`) as `true`, which would make the kill-switch itself unable to be
switched off. Also add `RANKING_FEWSHOT_LIMIT_PER_LABEL: z.coerce.number().int().positive().default(8)`.

#### 5. Worker entrypoint

**File**: `src/worker/rank.ts`

**Intent**: Thread the env values into `RankOptions`.

**Contract**: Build `fewShot: { enabled: env.RANKING_FEWSHOT_ENABLED, limitPerLabel:
env.RANKING_FEWSHOT_LIMIT_PER_LABEL }` from `loadWorkerEnv()`'s result and pass it into
`rankDigest`'s options alongside the existing `ceilingUsd`.

### Success Criteria:

#### Automated Verification:

- Existing ranking tests still pass with the flag defaulted on but no real `selection_item` rows
  in the test fixtures (empty few-shot list behaves identically to today): `npm test`
- New/updated unit tests for `buildRubricSystemPrompt` (empty vs. non-empty few-shot) pass
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- With `RANKING_FEWSHOT_ENABLED=0`, `npm run rank -- --digest=<uuid>` produces byte-identical
  scoring behavior to before this change (same rubric text sent to the model).
- With the flag on and at least one real confirmed selection in the database, run `npm run rank`
  on a fresh digest and confirm (via added logging or a debugger) that the sent system prompt
  includes the "PAST EDITORIAL DECISIONS" section.

---

## Phase 5: Eval-set disjointness guarantee

### Overview

Make `rubric.ts`'s own stated constraint — few-shot content must never overlap the held-out eval
set — mechanically enforced rather than a comment-only promise.

### Changes Required:

#### 1. Disjointness checker

**File**: `src/lib/ranking/eval/disjointness.ts` (new)

**Intent**: A pure function the eval gate (and, defensively, production code) can call to detect
overlap between real few-shot content and `EVAL_EXAMPLES`.

**Contract**: `export function findEvalOverlap(examples: FewShotExample[]): string[]` — normalizes
(trim + lowercase) each example's `title` and each `EVAL_EXAMPLES` entry's `title`, and returns
the list of normalized titles present in both sets (empty array = safe). Title match is
sufficient (not lede) since `EVAL_EXAMPLES` titles are themselves the unique identifying text.

#### 2. Eval gate extension

**File**: `src/lib/ranking/eval/rubric.eval.test.ts`

**Intent**: Prove the guarantee holds against real data, not just synthetic fixtures, on every
`RANKING_EVAL` run — the gate this project's own convention already requires before shipping any
rubric change.

**Contract**: Inside the existing `it(...)` block, after building the `Scorer`, call
`fetchFewShotExamples(db, { limitPerLabel: <same default as production> })` for real, assert
`findEvalOverlap(result)` is empty (failing the test with the offending titles if not), and pass
the fetched examples into `scoreExample`'s few-shot parameter (Phase 4) so the eval genuinely
exercises the same few-shot-enabled prompt production ranking would use — not a zero-shot
approximation of it.

### Success Criteria:

#### Automated Verification:

- New unit tests for `findEvalOverlap` pass, covering an exact-title overlap, a
  case/whitespace-only difference (still counted as overlap), and a clean disjoint set: `npm test -- disjointness`
- `RANKING_EVAL=1 npm test` passes (opt-in — requires `SUPABASE_TEST_PROJECT=1` and
  `ANTHROPIC_API_KEY`)
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- None beyond running the opt-in `RANKING_EVAL` gate above — this phase's entire purpose is
  automated enforcement.

---

## Phase 6: End-to-end verification and closing OQ#5

### Overview

Confirm both tracks work together against real data, and close the roadmap's open retention
question with the decision already made during planning.

### Changes Required:

#### 1. Roadmap documentation

**File**: `context/foundation/roadmap.md`

**Intent**: Resolve Open Roadmap Question #5 the way every other resolved question in that file is
recorded (struck through with a resolution note), rather than leaving it dangling after this
slice ships.

**Contract**: Strike through OQ#5's text and append a resolution note: retention is "keep
everything indefinitely" — archive material lives in Supabase Storage (cloud), not the Pi's local
disk as originally worded, and per-digest footprint is small enough that no cleanup mechanism is
warranted; revisit only if Supabase storage cost becomes a real concern.

### Success Criteria:

#### Automated Verification:

- Full test suite passes: `npm test`
- `RANKING_EVAL=1 npm test` passes against real historical `selection_item` data (once any exists)
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Production build succeeds: `npm run build`

#### Manual Verification:

- Browse a real past digest end to end: shortlist with scores/rationale on `[id].astro`,
  generated copy + visuals + publish results on `approve.astro`.
- Page through more than 25 digests on the dashboard list; confirm the `active` filter narrows
  correctly.
- Run `npm run rank` on a real digest with the few-shot flag on; confirm via `cacheReadTokens` /
  `cacheCreationTokens` (surfaced by `invoke()`'s result) that the extended system prompt still
  triggers caching.
- Flip `RANKING_FEWSHOT_ENABLED=0` and confirm a re-run reverts to the pre-S-09 rubric text with
  no deploy.

---

## Testing Strategy

### Unit Tests:

- `few-shot.ts`: picked/passed split, per-label cap, most-recent-first ordering, skip-on-missing-representative
- `buildRubricSystemPrompt`: empty few-shot list returns `GEOGRAPHY_RUBRIC_SYSTEM` unchanged;
  non-empty list appends a well-formed section
- `findEvalOverlap`: exact match, normalized (case/whitespace) match, clean disjoint set

### Integration Tests:

- `RANKING_EVAL=1 npm test` (opt-in, already-existing suite) extended to assert disjointness
  against real few-shot query output, and to score the held-out set through the actual
  few-shot-enabled prompt

### Manual Testing Steps:

1. Open an old digest at `/dashboard/<id>` — confirm all 15 shortlist cards show tier, score, and
   rationale, with picks marked "selected."
2. Open that same digest's `/dashboard/<id>/approve` — confirm generated copy, visuals, and
   publish results still render exactly as before (no regression from Phase 1's type changes).
3. On `/dashboard`, page past 25 digests via "Older →" and toggle the `active` filter.
4. Run `npm run rank` twice — once with `RANKING_FEWSHOT_ENABLED=0`, once with `=1` — and diff the
   system prompt sent to `invoke()` to confirm the flag actually changes behavior.

## Performance Considerations

Few-shot examples are fetched once per `rankDigest` call (not per batch), so the added query cost
is two small indexed reads (`selection_item_cluster_id_idx`) regardless of pool size. The
extended system prompt still shares one `cacheSystem: true` prefix across all batches within a
run; growth is capped at `2 × RANKING_FEWSHOT_LIMIT_PER_LABEL` examples regardless of how much
`selection_item` history accumulates, bounding both prompt-dilution and cache-write cost growth
over the product's lifetime.

## Migration Notes

No schema migration required — `selection_item`, `cluster.scoring_detail`, and `generated_asset`
already exist, provisioned by S-04/S-02/S-06 with S-09 in mind. This plan is purely additive: new
optional fields, one new module, one new env var with a safe default.

## References

- Roadmap: `context/foundation/roadmap.md` (S-09 entry, lines 262-273; OQ#5, line 271)
- PRD: `context/foundation/prd.md` (FR-024, FR-025, FR-026, US-10, US-21)
- Prior design intent: `supabase/migrations/20260829120000_selection_gate.sql`,
  `supabase/migrations/20260906140000_selection_item_indexes.sql`
- Zero-shot constraint: `src/lib/ranking/rubric.ts:1-4`
- Existing archive-detail precedent: `src/pages/dashboard/[id]/approve.astro`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not
> rename step titles. See `references/progress-format.md`.

### Phase 1: Surface score + rationale on shortlist cards

#### Automated

- [x] 1.1 Type checking passes: `npm run typecheck` — e302e88
- [x] 1.2 Linting passes: `npm run lint` — e302e88
- [x] 1.3 Full test suite passes: `npm test` — e302e88

#### Manual

- [x] 1.4 Every shortlist card shows tier, score, and rationale; picks/passes render correctly — e302e88
- [x] 1.5 Pre-S-09 digest without scoring_detail renders without crash or placeholder text — e302e88

### Phase 2: Archive list — pagination + status filter

#### Automated

- [x] 2.1 Type checking passes: `npm run typecheck` — b46f18f
- [x] 2.2 Linting passes: `npm run lint` — b46f18f

#### Manual

- [x] 2.3 "Older →" pagination works and disappears at the oldest digest — b46f18f
- [x] 2.4 `active` filter narrows correctly; default view unchanged — b46f18f

### Phase 3: Few-shot example retrieval

#### Automated

- [x] 3.1 New unit tests pass: `npm test -- few-shot`
- [x] 3.2 Type checking passes: `npm run typecheck`
- [x] 3.3 Linting passes: `npm run lint`

### Phase 4: Wire few-shot into the rubric prompt behind a config flag

#### Automated

- [ ] 4.1 Existing ranking tests pass with flag on and no fixture selection_item rows
- [ ] 4.2 New unit tests for `buildRubricSystemPrompt` pass
- [ ] 4.3 Type checking passes: `npm run typecheck`
- [ ] 4.4 Linting passes: `npm run lint`

#### Manual

- [ ] 4.5 Flag off reproduces pre-S-09 scoring behavior exactly
- [ ] 4.6 Flag on with real selection data includes the few-shot section in the sent prompt

### Phase 5: Eval-set disjointness guarantee

#### Automated

- [ ] 5.1 New unit tests for `findEvalOverlap` pass
- [ ] 5.2 `RANKING_EVAL=1 npm test` passes
- [ ] 5.3 Type checking passes: `npm run typecheck`
- [ ] 5.4 Linting passes: `npm run lint`

### Phase 6: End-to-end verification and closing OQ#5

#### Automated

- [ ] 6.1 Full test suite passes: `npm test`
- [ ] 6.2 `RANKING_EVAL=1 npm test` passes against real historical data
- [ ] 6.3 Type checking passes: `npm run typecheck`
- [ ] 6.4 Linting passes: `npm run lint`
- [ ] 6.5 Production build succeeds: `npm run build`

#### Manual

- [ ] 6.6 Full archive browse (shortlist + approve page) verified on a real past digest
- [ ] 6.7 Pagination and filter verified past 25 digests
- [ ] 6.8 Cache engagement confirmed via `cacheReadTokens`/`cacheCreationTokens`
- [ ] 6.9 Kill-switch confirmed to revert behavior with no deploy
