# Geography-Ranking Rubric (with Eval Harness) — Plan Brief

> Full plan: `context/changes/geography-ranking-rubric/plan.md`
> Change identity & seeded context: `context/changes/geography-ranking-rubric/change.md`

## What & Why

The `ranking` stage clusters the week's article pool into stories, scores each cluster by a
geography-first editorial rubric, and keeps the top 15 — turning a flat pile of ~234 articles into a
ranked shortlist. This is the product's differentiator: editorial judgment, geography-first, not
scraping. It is the last prerequisite before the north-star S-03 (the operator-facing shortlist).

## Starting Point

S-01 leaves the digest in `ranking` with a persisted `article` pool; F-03's cost-ceilinged `invoke()`
is the required path for every model call. F-01 already provisioned the `cluster` table
(`relevance_score`, `coverage_count`, `rank`) and `article.cluster_id` — the core schema exists. No
embedding capability exists (Anthropic has none, no pgvector), which is why clustering is LLM-based.

## Desired End State

`npm run rank` takes a `ranking` digest, clusters its articles, scores every cluster, ranks by
relevance with coverage as a tiebreaker, writes clusters (top 15 ranked, the rest persisted unranked)
with each article assigned to a cluster, and moves the digest to `ready_for_selection`. Running the
eval (`RANKING_EVAL=1 npm test`) passes only when every labeled example is in its correct geography
tier and every expected ordering holds.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Clustering | LLM, single-pass | Anthropic-only stack; no embedding provider/pgvector; ~17k tokens fits context | Plan |
| Eval gate | Tier + ordering, not exact scores | Robust to LLM score jitter while catching a tier flip or inversion (the real regressions) | Plan |
| Score schema | tier + topics + 0–100 + rationale | Tier is what the gate asserts; rationale aids tuning & feeds S-09 | Plan |
| Scoring calls | Many clusters per `invoke()`, bounded concurrency | Fewer calls → less ceiling exposure; caps the soft-ceiling overshoot; caches the rubric prefix | Plan |
| Coverage boost | Tiebreaker within close scores | Keeps geography primary (FR-007); coverage nudges, doesn't override (US-07) | Plan |
| Top-15 | Score all, rank all, keep 15; persist rest unranked | Full-fidelity archive for S-09; thin week degrades gracefully; nothing destructively dropped | Plan |
| Failure / re-run | Fail with diagnostic; re-run clears clusters | Matches S-01's pattern; clustering isn't idempotent, so re-cluster clean | Plan |
| Sequencing | Eval harness + labels **before** rubric | The gate exists before there's anything to regress (FR-026/US-25 intent) | Plan |
| Eval set | ~15–25 hand-curated from the real pool | Real Spanish/Catalan articles; encodes US-06/US-08; covers the tiers | Plan |
| Harness form | Opt-in Vitest suite (`RANKING_EVAL=1`) | Reuses the live-smoke pattern; CI stays hermetic/free | Plan |
| Scoring model | Sonnet 5 (F-03 default) | Near-Opus judgment at ~40% less; a week stays under $5; the eval can arbitrate an Opus upgrade later | Plan |
| Eval integrity | Held out — never in the rubric prompt | An eval scoring its own few-shot proves memorization, not generalization | Plan |

## Scope

**In scope:** LLM clustering, the geography rubric + scoring function (via F-03), rank ordering with
coverage tiebreak, `scoring_detail jsonb` migration, the eval harness + held-out labeled set, the
`ranking → ready_for_selection` transition, the `npm run rank` entrypoint.

**Out of scope:** translation (S-03), the dashboard/shortlist view (S-03/F-02), the Batches API
(deferred), embeddings, S-09's learning loop, article-body fetching.

## Architecture / Approach

Eval-first, then bottom-up. The eval scores each labeled article as a **singleton cluster** — the same
path the real scorer uses — so the rubric can be built and gated before clustering exists. The eval
set is **held out** of the prompt (the rubric starts zero-shot) so the gate measures generalization.

```
pool → cluster (1 LLM call) → score clusters (few batched invoke() calls, rubric cached)
     → rank (score desc, coverage tiebreak) → top 15 shortlist + rest unranked
     → ready_for_selection
Eval:  held-out labels → score as singleton clusters → assert tier + ordering
```

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema, storage & eval harness | Score schema, `scoring_detail` migration, labeled set, assertion harness | Curating "known-correct" labels before observing real model behavior |
| 2. Rubric & scoring function | The FR-007 rubric + `scoreClusters` via F-03; tuned against the gate | The published-vs-effects distinction is the PRD's flagged likely misjudgment |
| 3. LLM clustering | Single-pass grouping; coverage_count | A malformed partition (dropped/duplicated ids) — validated and failed loudly |
| 4. Ranking orchestrator | Compose cluster→score→rank→persist→transition | Ceiling hit mid-scoring; re-run clustering correctness |
| 5. Entrypoint & integration | `npm run rank`, integration tests, docs | End-to-end wiring; the first real ranked shortlist |

**Prerequisites:** S-01 and F-03 (both shipped). Needs SQL-Editor access for the Phase 1 migration and
`ANTHROPIC_API_KEY` (already set). Operator time to review the labeled set.
**Estimated effort:** ~4–5 sessions across five phases; Phase 1 gated on the manual SQL step and label review.

## Open Risks & Assumptions

- **The labeled set is curated before observing the model.** Some "known-correct" labels may need
  revising once real scoring is seen — acceptable, and the held-out design keeps revisions honest.
- **The soft ceiling under concurrency.** Scoring caps its fan-out so `concurrency × per-call` stays
  small against $5; if a week is unexpectedly large or Opus is adopted, revisit the cap.
- **Zero-shot rubric may score less consistently at first.** Few-shot is deferred to S-09 (from
  picks/passes, disjoint from the eval); if consistency is poor, add few-shot from non-eval articles.
- **Sonnet may misjudge the subtle geography calls.** The eval harness is exactly what would catch
  that and justify an Opus upgrade with data rather than a guess.

## Success Criteria (Summary)

- The eval passes on the shipped rubric, and a deliberate rubric regression makes it fail.
- `npm run rank` on a real digest yields a shortlist where a Barcelona housing story outranks a Madrid
  political one, multi-source stories are annotated by coverage, and the digest reaches `ready_for_selection`.
- A full week's ranking stays under the $5 ceiling.
