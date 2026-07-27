<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Geography-Ranking Rubric (with Eval Harness)

- **Plan**: context/changes/geography-ranking-rubric/plan.md
- **Scope**: Phase 1 of 5 (full plan — all phases complete)
- **Date**: 2026-07-27
- **Verdict**: APPROVED (all findings triaged and resolved — see Decisions below)
- **Findings**: 0 critical, 2 warnings (both resolved), 1 observation (accepted)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS (F2 accepted as documented) |
| Safety & Quality | PASS (F1 fixed via bulk-write RPC functions) |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Sequential per-cluster writes in the persist path

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Performance)
- **Location**: `src/lib/ranking/rank.ts:82-88` (article → cluster assignment) and `src/lib/ranking/rank.ts:179-183` (rank/score persistence)
- **Detail**: Both loops `await` one Supabase `.update()` per cluster inside a `for` loop rather than batching. On the real ~368-article pool this produced ~250 clusters, so a full run does roughly 500 sequential round trips (250 article-assignment updates + 250 rank/score updates) purely for persistence, on top of the LLM calls. It worked correctly in the live run — this is an efficiency finding, not a correctness one — but it's the dominant scaling cost as the pool grows, since it's O(n) sequential network round trips rather than O(1) batched writes.
- **Fix**: Batch each phase into a single bulk write — group articles by cluster and issue one `.update()` per distinct `cluster_id` value isn't the fix (still N calls); the real fix is a single `upsert` with all rows in one request (Supabase/PostgREST supports multi-row upsert), or a `plpgsql` function that takes an array and does the assignment in one round trip.
  - Strength: Cuts persistence from O(n) sequential round trips to O(1), the same pattern the codebase already avoids elsewhere (e.g. `collect.ts`'s batched article insert).
  - Tradeoff: A multi-row upsert for the article→cluster assignment needs a shape Supabase's JS client can express in one call; may need a small rework of `persistClusters`'s article-update step specifically (the `cluster` insert itself is already a single batched call).
  - Confidence: MEDIUM — the pattern is standard, but the exact PostgREST upsert shape for "update `cluster_id` on articles matching one of N different id-lists, each to a different value" isn't a single trivial `.update()` and needs either an RPC or a `upsert` keyed by article id with the cluster payload embedded per row.
  - Blind spot: Whether this matters in practice depends entirely on pool size trajectory — this is a once-a-week background job with no human waiting on it, so the ~500-call cost (well under a minute of wall clock, non-blocking) may be an acceptable tradeoff against the complexity of a bulk-write rework, especially given F-03's cost-ceiling design already treats this stage as tolerant of slower, careful sequential operations.
- **Decision**: FIXED. Added `assign_articles_to_clusters` and `persist_cluster_rankings` Postgres RPC functions (`supabase/migrations/20260727150000_bulk_ranking_writes.sql`, same "PostgREST can't express it, so make it a function" precedent as `increment_digest_cost`), since `.upsert()` is typed against the table's full `Insert` shape and can't express a partial-row bulk update. `rank.ts`'s `persistClusters`/`persistRanking` now call these via `.rpc()` — one round trip per phase instead of one per cluster. Verified against the live (migrated) database: `rank.test.ts`'s real integration suite, the full test suite, typecheck, lint, and build all pass.

### F2 — `invoke.ts` modified outside Phase 5's planned file list

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: `src/lib/llm/invoke.ts` (adds an optional `thinking` field to `LlmRequest` and threads it into `buildParams`)
- **Detail**: Phase 5's plan named only `src/worker/rank.ts`, `package.json`, and `CLAUDE.md` as changed files. `invoke.ts` — a shared F-03 harness file, not owned by this slice — was also modified, discovered necessary only during real-pool verification against production data: Sonnet 5 runs adaptive thinking by default when `thinking` is omitted, silently consuming the `maxTokens` budget meant for clustering's JSON output and causing repeated truncation no matter how high `maxTokens` was raised. This is a real, well-justified fix (documented in the roadmap's Carried-forward note and in the commit message), not scope creep — but it technically touches a shared foundation file the plan didn't name.
- **Fix**: Accept as documented — the addition is a narrow, additive, optional field (`thinking?: boolean`) that changes behavior only for callers that explicitly pass it (only `cluster.ts` does), so existing F-03 callers (`score-clusters.ts`) are unaffected. No code change needed; this finding exists to make the deviation visible in the review record.
- **Decision**: ACCEPTED — no code change. Deviation is intentional, narrowly scoped, and already documented in the roadmap's Carried-forward note and the `p5` commit message.

### F3 — Manual Progress rows lack a commit-SHA suffix

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: `context/changes/geography-ranking-rubric/plan.md` — every `- [x]` row under a `#### Manual` heading (e.g. 1.7, 1.8, 2.4-2.6, 3.4, 4.7, 5.4-5.6)
- **Detail**: Manual verification rows record operator confirmation or a live-run observation rather than a code diff, so they end in descriptive text ("operator-confirmed", "demonstrated repeatedly during live debugging") instead of a bare commit SHA. This is consistent with the already-archived F-03 plan, which shows the same pattern (and in fact many of *its* rows also fail a strict "SHA at end of line" check once a parenthetical follows the SHA) — this is an inherent property of manual-verification rows, not a defect introduced here.
- **Fix**: None needed — noted for completeness since `/10x-archive`'s soft-warning heuristic flags these rows; the heuristic itself acknowledges they're "legitimate for empty-diff phases," and manual confirmations are exactly that case.
- **Decision**: ACCEPTED — no change. Inherent property of manual-verification rows, consistent with the already-archived F-03 plan.
