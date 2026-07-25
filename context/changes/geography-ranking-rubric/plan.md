# Geography-Ranking Rubric (with Eval Harness) Implementation Plan

## Overview

Build the `ranking` stage of the weekly digest: cluster the collected article pool into stories,
score each cluster by a geography-first editorial rubric, rank by relevance with coverage count as
a tiebreaker, keep the top 15 as the shortlist, and move the digest `ranking → ready_for_selection`.
An eval harness — built **before** the rubric — gates any rubric change against a held-out set of
hand-labeled examples, asserting geography tier and pairwise ordering rather than exact scores.

This is roadmap slice S-02, the product's editorial differentiator and the last prerequisite before
the north-star S-03. It consumes S-01's article pool and F-03's cost-ceilinged `invoke()`.

## Current State Analysis

The two prerequisites are shipped, and F-01 already provisioned most of the schema this slice needs.

- **The digest arrives in `ranking` with a persisted pool.** S-01 leaves articles in `article`
  (`original_title`, `original_lede`, `source_name`, `source_url`, no body column) and the digest in
  `ranking` (234 on the first real run). `ranking → ready_for_selection` and `ranking → failed` are
  the only legal moves (`src/lib/digest/state-machine.ts:15`).
- **The `cluster` table already exists** (`supabase/migrations/20260722173032_digest_core_schema.sql:59`):
  `relevance_score numeric(4,2)`, `coverage_count int`, `rank int`, and `article.cluster_id` FK
  (`on delete set null`). The core ranking needs no new columns — only a `scoring_detail jsonb` for
  the tier/topic/rationale the numeric score can't hold.
- **F-03's `invoke()` is the required path for every model call** (`src/lib/llm/invoke.ts`). It
  enforces the per-digest ceiling, accounts cost, and returns structured output parsed to a zod
  schema with one corrective reprompt. `markStageComplete(client, id, 'ranking')` records the
  checkpoint (`src/lib/digest/run-state.ts:37`).
- **No embedding or vector capability exists** — Anthropic has no embedding API and there is no
  pgvector setup (only a commented `config.toml` line). Clustering is therefore LLM-based, which
  keeps the slice inside the shipped Anthropic-only stack.
- **The worker runtime and its conventions are established** — plain Node via `tsx --env-file=.env`,
  runtime-neutral modules taking their client as a parameter, the `RunStateResult`/`LlmResult`
  discriminated-result idiom, integration tests gated on `SUPABASE_TEST_PROJECT=1`, and the opt-in
  live-test pattern (`COLLECTION_LIVE_SMOKE`, `LLM_LIVE_SMOKE`).

### Key Discoveries:

- **The rubric is fully specified by FR-007.** Geography tiers — Catalonia/Barcelona > Spain-wide
  nationally-applicable > global-with-Spanish-impact > other-regions-local (discard) — refined by
  topic (rental/purchase prices, mortgage rates, new construction, regulation boosted; local or
  purely political news sunk). The load-bearing rule, PRD-flagged as the likely misjudgment:
  separate where a story is *published* from where its *effects* land (a national announcement made
  in Madrid is national, not "Madrid news").
- **US-25's eval is over a non-deterministic scorer.** "Known-correct" cannot be an exact-score
  match. The gate asserts each example lands in its correct tier and that key ordering pairs hold
  (US-06's Barcelona-rental > Madrid-political), which is robust to LLM score jitter while still
  catching a tier flip or an inversion — the regressions that matter.
- **Coverage is a boost, not a dedup signal (FR-004/FR-005).** Semantic clustering makes one story
  one cluster; `coverage_count` (outlets in the cluster) breaks ties within close scores, keeping
  geography primary.
- **The soft ceiling (F-03 impl-review F1).** The ceiling check and the cost increment are separate
  round trips, so under concurrency the overshoot bound is `concurrency × per-call cost`, not one
  call. Scoring the pool is the concurrent workload F-03 was built for — the scoring loop caps its
  fan-out so that product stays small against the $5 ceiling.

## Desired End State

`npm run rank` (or the same code invoked after collection) takes a digest in `ranking`, clusters its
articles, scores every cluster, ranks them, writes `cluster` rows (`relevance_score`, `rank`,
`coverage_count`, `scoring_detail`) with each article assigned a `cluster_id`, and transitions the
digest to `ready_for_selection`. The top 15 clusters carry `rank` 1–15; the rest are persisted with
`rank` null. Running the eval harness (`RANKING_EVAL=1 npm test`) scores the held-out labeled set
through the real rubric and passes only when every example is in its correct tier and every expected
ordering pair holds.

**Verification:** the eval harness passes on the shipped rubric; a deliberate rubric regression (e.g.
deleting the published-vs-effects instruction) makes it fail; `npm run rank` against a real `ranking`
digest produces a spot-checkable shortlist where a Barcelona housing story outranks a Madrid political
one; a digest with an empty pool fails with a diagnostic; a re-run reclusters cleanly.

## What We're NOT Doing

- **Not translating.** FR-009 batch translation to Polish is S-03, run once on the shortlist. This
  slice scores the Spanish/Catalan originals and writes nothing to `polish_title`/`polish_summary`.
- **Not building the dashboard.** The shortlist view (FR-008 display, language flags) is S-03/F-02.
- **Not using the Message Batches API.** Considered for the 50% discount, but batch semantics don't
  fit F-03's per-call ceiling (an unhaltable unit) and F-03 deferred it. Scoring uses ordinary
  `invoke()` calls, batching multiple clusters *per prompt* instead.
- **Not using embeddings.** Clustering is LLM-based; no new provider, no pgvector.
- **Not the learning loop.** S-09 feeds picks/passes back as few-shot material. This slice ships a
  zero-shot rubric and a held-out eval set; it only ensures the two stay disjoint so S-09 is safe.
- **Not fetching article bodies.** Scoring is from `original_title` + `original_lede` only (FR-006).

## Implementation Approach

Eval-first, then bottom-up. The regression gate and its labeled set are built before the rubric, so
the rubric is tuned against the gate from its first commit (FR-026/US-25's intent — the gate exists
before there is anything to regress). Then the rubric and scoring function, then clustering, then the
orchestrator that composes them, then the entrypoint.

Two controlling decisions. First, **the eval scores singleton clusters**: each labeled article is
scored exactly as the real scorer scores a cluster's content (title + lede), so the eval exercises
the real rubric without depending on clustering — which is why the rubric (Phases 1–2) can be built
and gated before clustering (Phase 3). Second, **the eval set is held out of the prompt**: an eval
that scored its own few-shot examples would prove memorization, not generalization, so the rubric
starts zero-shot and any future few-shot (from S-09) must be disjoint from the eval set.

## Critical Implementation Details

**The score is stored twice, deliberately.** `relevance_score numeric(4,2)` is the queryable number
ranking sorts on; `scoring_detail jsonb` holds the tier, topic tags, and rationale the column can't
enforce — the same split S-01 used for `collection_report`. The zod score schema validates the jsonb
shape in app code; the DB does not.

**Structured-output schema limits (from F-03).** The score schema must avoid numeric and
string-length constraints (`z.number().min()/max()`, `z.string().min()`) — F-03's `toStructuredFormat`
rejects them at call time. Validate the 0–100 range in application code after parsing, not in the zod
schema sent to the API.

**Migration delivery is manual.** The `scoring_detail` migration goes through the Supabase SQL Editor
with its `schema_migrations` row inserted in the same script (port 5432 is unreachable here), and the
`Database` type is hand-edited if gen-types is still privilege-blocked — both per the S-01 and F-03
precedents recorded in their archived plans.

## Phase 1: Score schema, storage & eval harness

### Overview

Build the gate before the rubric: the score schema, the jsonb column to persist it, the hand-labeled
example set, and the tier/ordering assertion harness.

### Changes Required:

#### 1. Score schema

**File**: `src/lib/ranking/score.ts` (new)

**Intent**: The validated shape of a cluster's score — the contract the rubric produces, the eval
asserts on, and the orchestrator persists.

**Contract**: a zod schema exporting `GEOGRAPHY_TIERS` (`catalonia` | `national` | `global` |
`discard`) and `ClusterScore` = `{ tier, topics: string[], score: number (0–100), rationale: string }`.
No numeric/length constraints in the schema (F-03 limit); a separate `assertScoreInRange` validates
0–100 after parse. Also exports the tier→base-score band mapping the rubric and eval share.

#### 2. Scoring-detail storage

**File**: `supabase/migrations/<timestamp>_cluster_scoring_detail.sql` (new)

**Intent**: Persist the tier/topic/rationale alongside the numeric `relevance_score`, for S-09
fidelity and debugging, without the DB enforcing the shape.

**Contract**: `alter table cluster add column scoring_detail jsonb;` (nullable — a cluster has no
detail until scored). No RLS change (deny-by-default already). Delivered via SQL Editor + the
`schema_migrations` row; regenerate/hand-edit `Database` types.

#### 3. Labeled example set

**File**: `src/lib/ranking/eval/examples.ts` (new)

**Intent**: The held-out known-correct set the gate runs against — real articles, real judgments.

**Contract**: ~15–25 entries, each `{ title, lede, expectedTier, note }`, curated from the real
S-01 pool to span all four tiers including the subtle published-vs-effects cases (a Madrid-datelined
national story labeled `national`). Plus an `EXPECTED_ORDERINGS` list of `[higherId, lowerId]` pairs
encoding US-06/US-08 (Barcelona rental > Madrid political). Held out — these never appear in a rubric
prompt.

#### 4. Eval assertion harness

**File**: `src/lib/ranking/eval/harness.ts` (new)

**Intent**: Given a scorer, check every example's tier and every ordering pair — the reusable gate.

**Contract**: `evaluateRubric(scorer, examples, orderings)` returning a structured report
(`{ tierFailures, orderingFailures, passed }`). Pure over an injected scorer, so its assertion logic
is unit-testable on synthetic scored data with no API call.

#### 5. Eval Vitest suite

**File**: `src/lib/ranking/eval/rubric.eval.test.ts` (new)

**Intent**: Run the gate against the real rubric, opt-in like the live-smoke tests.

**Contract**: gated on `RANKING_EVAL=1` (mirroring `LLM_LIVE_SMOKE`); wires the real scorer (Phase 2)
to `evaluateRubric` and asserts `passed`. Skips by default so CI stays hermetic and free. Until Phase
2 lands, it is written against the scorer interface and skips.

### Success Criteria:

#### Automated Verification:

- `ClusterScore` schema round-trips a valid score and rejects a bad tier: unit test
- `assertScoreInRange` accepts 0–100 and rejects out-of-range: unit test
- `evaluateRubric` reports tier and ordering failures correctly on synthetic scored data: unit test
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Existing suite still green: `npm test`

#### Manual Verification:

- `scoring_detail` column and the migration's `schema_migrations` row visible in Studio
- The labeled set covers all four tiers, including at least two published-vs-effects cases, and the
  operator agrees with the labels

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation (especially the label review) before proceeding.

---

## Phase 2: Geography rubric & scoring function

### Overview

Write the rubric and the scoring function, and tune the rubric against the Phase 1 gate until it
passes.

### Changes Required:

#### 1. The rubric prompt

**File**: `src/lib/ranking/rubric.ts` (new)

**Intent**: The FR-007 geography-first rubric as a stable, versioned system prompt — the product's
editorial judgment in words.

**Contract**: an exported system-prompt string encoding the tier definitions, the published-vs-effects
rule, and the topic boosts/sinks, instructing the model to return the `ClusterScore` shape. Zero-shot
(no examples from the eval set). Stable and large enough to be a worthwhile cache prefix (Phase 4
passes `cacheSystem: true`).

#### 2. Scoring function

**File**: `src/lib/ranking/score-clusters.ts` (new)

**Intent**: Score clusters through F-03's `invoke()` with the rubric and schema, batching several
clusters per call under bounded concurrency.

**Contract**: `scoreClusters(llm, db, digestId, clusters, options)` sending N clusters per `invoke()`
call (each carrying its title+lede set and a stable local id), parsing the array of `ClusterScore`
back via the schema, and returning scores keyed by cluster. Concurrency is bounded and small so
`concurrency × per-call cost` stays well under the ceiling (F-03 F1). A per-call `max_tokens` sized
for the batch. Passes `cacheSystem: true` for the rubric prefix; surfaces `cacheReadTokens` so caching
can be verified.

#### 3. Singleton-cluster adapter for the eval

**File**: `src/lib/ranking/eval/harness.ts` (extend) or `score-clusters.ts`

**Intent**: Let the eval score a labeled article as a one-article cluster, exercising the real path.

**Contract**: a thin wrapper turning a labeled example into a singleton cluster and returning its
`ClusterScore`, wired as the `scorer` the Phase 1 suite consumes.

### Success Criteria:

#### Automated Verification:

- `scoreClusters` parses a batched multi-cluster response into per-cluster scores: unit test (mock transport)
- A malformed batch response triggers F-03's reprompt path: unit test (mock transport)
- Type checking, linting and the full suite pass

#### Manual Verification:

- `RANKING_EVAL=1 npm test` passes: every labeled example lands in its correct tier and every ordering pair holds
- Deleting the published-vs-effects instruction from the rubric makes the eval fail (the gate has teeth)
- Spot-check a handful of rationales for sane editorial reasoning

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation (the eval pass + the deliberate-regression check) before proceeding.

---

## Phase 3: LLM clustering

### Overview

Group the article pool into stories in a single pass, and record coverage.

### Changes Required:

#### 1. Clustering function

**File**: `src/lib/ranking/cluster.ts` (new)

**Intent**: Turn the flat article pool into clusters of same-story articles (FR-004), the input the
scorer and the ranker consume.

**Contract**: `clusterArticles(llm, db, digestId, articles, options)` sending the pool's
title+lede+id set to `invoke()` with a schema that returns groups of article ids (one group per
story). Single-pass — the pool (~234 × ~75 tokens ≈ 17k) fits Sonnet's context comfortably. Returns
cluster groupings; a singleton article is a cluster of one. Validates that every returned id is a
real article id and that the grouping partitions the pool (no dropped or duplicated ids), failing
loudly on a malformed partition.

### Success Criteria:

#### Automated Verification:

- A mocked grouping response partitions a known article set into the expected clusters: unit test
- A grouping that drops or duplicates an id is rejected: unit test
- Type checking, linting and the full suite pass

#### Manual Verification:

- On the real pool, obviously-same stories (a story carried by 3 outlets) land in one cluster, and
  unrelated stories are not merged — spot-checked

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation before proceeding.

---

## Phase 4: Ranking orchestrator

### Overview

Compose the stage: cluster, score, rank, persist, transition.

### Changes Required:

#### 1. Ranking orchestrator

**File**: `src/lib/ranking/rank.ts` (new)

**Intent**: The stage entry point — everything between "a digest is in `ranking`" and "the digest is
in `ready_for_selection` or `failed`".

**Contract**: takes a client and a digest and (a) reads the article pool; (b) on a re-run, deletes
this digest's existing clusters first (clustering is not idempotent, so re-cluster from scratch);
(c) clusters via `clusterArticles`; (d) persists `cluster` rows with `coverage_count` and assigns
each article's `cluster_id`; (e) scores via `scoreClusters`, writing `relevance_score` and
`scoring_detail`; (f) ranks by `relevance_score` desc with `coverage_count` as the tiebreaker within
a small score band, setting `rank` 1..N and marking the top 15 as the shortlist while persisting the
rest with `rank` null; (g) `markStageComplete('ranking')`; (h) transitions to `ready_for_selection`,
or to `failed` with `lastError` when the pool is empty or clustering/scoring yields nothing. A
ceiling hit during scoring surfaces as `ceiling_reached` and fails the digest with a diagnostic (the
caller-owns-transition contract from F-03).

#### 2. Coverage-tiebreaker ranking

**File**: `src/lib/ranking/rank-order.ts` (new)

**Intent**: The pure ordering function, testable without the DB.

**Contract**: `orderClusters(scored)` sorting by score desc, breaking ties (or near-ties within a
documented band) by `coverage_count` desc — geography stays primary (FR-007), coverage only nudges
(FR-005/US-07). Returns clusters in rank order.

### Success Criteria:

#### Automated Verification:

- `orderClusters` ranks by score, breaks a tie by coverage, and does not let coverage override a
  clear score gap: unit tests
- Orchestrator moves a non-empty pool to `ready_for_selection` with top-15 ranked and the rest
  rank-null (needs `SUPABASE_TEST_PROJECT=1`, mock transport)
- Empty pool → `failed` with `last_error` (needs `SUPABASE_TEST_PROJECT=1`)
- A re-run deletes prior clusters and re-clusters without duplicating (needs `SUPABASE_TEST_PROJECT=1`)
- A ceiling hit during scoring fails the digest with a diagnostic (needs `SUPABASE_TEST_PROJECT=1`)
- Type checking, linting and the full suite pass

#### Manual Verification:

- The persisted shortlist is readable in Studio: top-15 ranked, scores and `scoring_detail` present

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation before proceeding.

---

## Phase 5: Worker entrypoint & integration

### Overview

Make it runnable and document it.

### Changes Required:

#### 1. Ranking entrypoint

**File**: `src/worker/rank.ts` (new)

**Intent**: The manual trigger and the process the pipeline runs after collection.

**Contract**: loads env, builds the Supabase and LLM clients, resolves the digest to rank (the newest
digest in `ranking`, or `--digest=<id>`), invokes the orchestrator, prints a per-cluster summary
(rank, tier, score, coverage, cost), and exits non-zero when the run ends in `failed`. Refuses a
digest not in `ranking` with a clear message.

#### 2. Script

**File**: `package.json`

**Contract**: add `"rank": "tsx --env-file=.env src/worker/rank.ts"`.

#### 3. Documentation

**File**: `CLAUDE.md`

**Contract**: document `npm run rank`, the `RANKING_EVAL=1` eval command and that it must pass before
shipping a rubric change, and the note that the eval set is held out of the rubric prompt.

### Success Criteria:

#### Automated Verification:

- `npm run rank` completes end-to-end against a `ranking` digest and exits 0
- Digest-resolution unit tests (`--digest` wins; else newest `ranking`; refuse non-`ranking`)
- Full suite, type check, lint and build pass

#### Manual Verification:

- A real run leaves a digest in `ready_for_selection` with a plausible, spot-checked top-15 (a
  Barcelona housing story above a Madrid political one; multi-source stories annotated by coverage)
- `RANKING_EVAL=1 npm test` still passes against the shipped rubric
- Re-running reclusters and re-ranks without duplicating; a digest already past `ranking` is refused

**Implementation Note**: After completing this phase and all automated verification passes, pause for
final manual confirmation.

---

## Testing Strategy

### Unit Tests:

- Score schema and range validation; `evaluateRubric` on synthetic data; `orderClusters` ranking and
  tiebreak; clustering partition validation; `scoreClusters` batch parsing and reprompt (mock transport)

### Integration Tests (against the configured Supabase project, opt-in):

- Orchestrator end-to-end with a mock LLM transport: pool → clusters → scores → ranked shortlist →
  transition; empty-pool failure; re-run reclustering; ceiling-hit failure

### Eval Harness (opt-in, excluded from CI):

- `RANKING_EVAL=1 npm test` — the real rubric scored against the held-out labeled set, asserting tier
  + ordering; also the deliberate-regression check

### Manual Testing Steps:

1. Apply the `scoring_detail` migration; confirm the column and history row
2. Curate + review the labeled set with the operator
3. Run the eval; confirm it passes and that a deliberate rubric break fails it
4. `npm run rank` on a real digest; spot-check the shortlist ordering and rationales

## Performance Considerations

Scoring is the pipeline's most expensive stage. Batching several clusters per `invoke()` call keeps
the call count low (a handful, not ~50), which bounds both ceiling exposure and the soft-ceiling
concurrency overshoot; the shared rubric prefix caches across those calls (~0.1× on repeat input).
Clustering is a single call. At Sonnet 5 prices a full week is expected to sit comfortably under the
$5 ceiling with headroom.

## Migration Notes

Fourth project migration (`scoring_detail`), delivered via the SQL Editor with its `schema_migrations`
row inserted in the same script (5432 unreachable). Hand-edit `src/db/database.types.ts` if gen-types
remains privilege-blocked, per the F-03 precedent. No data migration — the column is nullable and
populated by the first ranking run.

## References

- Change identity & seeded context: `context/changes/geography-ranking-rubric/change.md`
- Roadmap item: `context/foundation/roadmap.md` (S-02)
- PRD: FR-004→008, FR-026; US-06, US-07, US-08, US-25; §Business Logic (the rubric statement)
- LLM harness (required call path): `context/archive/2026-07-24-llm-cost-ceiling-harness/` and `src/lib/llm/invoke.ts`
- Collection stage & its conventions (orchestrator, entrypoint, live-test, SQL-Editor delivery): `context/archive/2026-07-24-weekly-source-collection/`
- Schema: `supabase/migrations/20260722173032_digest_core_schema.sql` (`cluster`, `article`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Score schema, storage & eval harness

#### Automated

- [ ] 1.1 `ClusterScore` schema round-trips a valid score and rejects a bad tier
- [ ] 1.2 `assertScoreInRange` accepts 0–100 and rejects out-of-range
- [ ] 1.3 `evaluateRubric` reports tier and ordering failures correctly on synthetic data
- [ ] 1.4 Type checking passes: `npx astro check`
- [ ] 1.5 Linting passes: `npm run lint`
- [ ] 1.6 Existing suite still green: `npm test`

#### Manual

- [ ] 1.7 `scoring_detail` column and `schema_migrations` row visible in Studio
- [ ] 1.8 Labeled set covers all four tiers incl. ≥2 published-vs-effects cases; operator agrees with labels

### Phase 2: Geography rubric & scoring function

#### Automated

- [ ] 2.1 `scoreClusters` parses a batched multi-cluster response into per-cluster scores (mock transport)
- [ ] 2.2 A malformed batch response triggers F-03's reprompt path (mock transport)
- [ ] 2.3 Type checking, linting and the full suite pass

#### Manual

- [ ] 2.4 `RANKING_EVAL=1 npm test` passes: every example in its correct tier, every ordering pair holds
- [ ] 2.5 Deleting the published-vs-effects instruction makes the eval fail (the gate has teeth)
- [ ] 2.6 Spot-checked rationales show sane editorial reasoning

### Phase 3: LLM clustering

#### Automated

- [ ] 3.1 A mocked grouping partitions a known article set into the expected clusters
- [ ] 3.2 A grouping that drops or duplicates an id is rejected
- [ ] 3.3 Type checking, linting and the full suite pass

#### Manual

- [ ] 3.4 On the real pool, same-story articles land in one cluster; unrelated stories are not merged

### Phase 4: Ranking orchestrator

#### Automated

- [ ] 4.1 `orderClusters` ranks by score, breaks ties by coverage, does not let coverage override a clear score gap
- [ ] 4.2 Non-empty pool → `ready_for_selection` with top-15 ranked and the rest rank-null (needs `SUPABASE_TEST_PROJECT=1`)
- [ ] 4.3 Empty pool → `failed` with `last_error` (needs `SUPABASE_TEST_PROJECT=1`)
- [ ] 4.4 A re-run deletes prior clusters and re-clusters without duplicating (needs `SUPABASE_TEST_PROJECT=1`)
- [ ] 4.5 A ceiling hit during scoring fails the digest with a diagnostic (needs `SUPABASE_TEST_PROJECT=1`)
- [ ] 4.6 Type checking, linting and the full suite pass

#### Manual

- [ ] 4.7 The persisted shortlist is readable in Studio: top-15 ranked, scores and `scoring_detail` present

### Phase 5: Worker entrypoint & integration

#### Automated

- [ ] 5.1 `npm run rank` completes end-to-end against a `ranking` digest and exits 0
- [ ] 5.2 Digest-resolution unit tests (`--digest` wins; else newest `ranking`; refuse non-`ranking`)
- [ ] 5.3 Full suite, type check, lint and build pass

#### Manual

- [ ] 5.4 A real run leaves a digest in `ready_for_selection` with a plausible, spot-checked top-15
- [ ] 5.5 `RANKING_EVAL=1 npm test` still passes against the shipped rubric
- [ ] 5.6 Re-running reclusters/re-ranks without duplicating; a digest past `ranking` is refused
