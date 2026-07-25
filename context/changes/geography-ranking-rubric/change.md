---
change_id: geography-ranking-rubric
roadmap_id: S-02
title: Geography-ranking rubric (with eval harness)
status: planned
created: 2026-07-25
updated: 2026-07-25
prd_refs: [FR-004, FR-005, FR-006, FR-007, FR-008, FR-026, US-06, US-07, US-08, US-25]
roadmap: context/foundation/roadmap.md
archived_at: null
---

# S-02: Geography-ranking rubric (with eval harness)

The week's articles are semantically clustered (coverage count as a ranking *boost*, not
redundancy) and each cluster is scored by the geography-first rubric from title + lede — with an
eval harness that gates any rubric change against known-correct examples.

**This is the product.** The geography-first editorial judgment is the whole differentiator; every
other slice is comparatively known work. It is also the riskiest place for the system to misjudge.
It consumes S-01's article pool and F-03's cost harness, and it is the last prerequisite before the
north-star S-03 (the operator-facing translated shortlist).

## Notes

**Both prerequisites are shipped.** S-01 leaves a digest in `ranking` with a persisted `article`
pool (234 on the first real run); F-03's `invoke()` is the required path for every model call —
never touch `@anthropic-ai/sdk` directly. This slice writes the `ranking` stage: cluster the pool,
score each cluster, move the digest `ranking → ready_for_selection`.

**The rubric's load-bearing distinction (PRD flags it as the most likely misjudgment).** Rank by
where a story's *effects* land, not where it was *published*: Barcelona/Catalonia > Spain-wide >
global-with-Spanish-impact. A national announcement made in Madrid is *national*, not "Madrid
news". And it must touch money or regulation. Coverage count (how many outlets carried the story)
is a ranking *boost*, not a dedup signal — FR-004 assigns semantic dedup to clustering here.

**Eval-harness-first is the quality bet, not a nicety.** The regression gate must exist *before*
the rubric is tuned — any rubric change is gated against known-correct examples (FR-026). This is
what makes later rubric evolution (S-09's learning loop feeds picks/passes back as few-shot
material) safe. Plan the harness as a first-class deliverable, likely before the rubric it guards.

**Inherited constraint from F-03's impl review (F1).** The cost ceiling is *soft*, not atomic: the
check and the increment are separate round trips, so under concurrency the overshoot bound is
`concurrency × per-call cost`, not one call. Scoring ~234 articles is the concurrent workload F-03
was built for — **cap the scoring loop's fan-out** so `concurrency × per-call` stays small against
the $5 ceiling. See `context/archive/2026-07-24-llm-cost-ceiling-harness/`.

**Two cost levers F-03 left for this slice** (from the F-03 decision record): the **Batches API**
halves the cost of whole-pool scoring (it is asynchronous by nature — the digest sits in `ranking`
for hours), and **prompt caching** on the shared rubric prefix cuts repeat input to ~0.1× —
`invoke`'s `cacheSystem` flag plus the returned `cacheReadTokens` let you confirm it engaged
(below ~2048 tokens on Sonnet 5 it silently won't cache). Batch was explicitly deferred to S-02;
decide whether to use it here.

**Scoring input is title + lede only** (FR-006) — the `article` table has `original_title` /
`original_lede` and no body column by design. No article-body fetching.
