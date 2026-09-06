<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Story Selection Gate (S-04)

- **Plan**: context/changes/story-selection-gate/plan.md
- **Scope**: Phases 1-5 of 5 (full plan)
- **Date**: 2026-09-06
- **Verdict**: APPROVED (all 5 findings triaged and fixed 2026-09-06)
- **Findings**: 0 critical, 1 warning, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Evidence

- Commits `50f6515`, `7625131`, `babbdc2`, `2c6c167`, `b933aea` — 23 files, +2707/-70.
- Automated criteria re-run at review time: `npm run lint` (0 errors, 8 pre-existing `no-console`
  warnings in worker code), `npm run build` (pass), `npm test` (319 passed, 12 opt-in skips).
- Every planned file exists and matches its stated contract. `database.types.ts` hand-edits are
  recorded in the header's EXCEPTION list for both new migrations, as the plan required.
- Two additions beyond the written plan are both documented and pre-approved in `change.md`:
  the SQL/TS pick-bounds drift guard, and `article.language` (Phase 2).
- Every "What We're NOT Doing" boundary holds: no generation, no `feedback_label`, no undo
  transition, no per-story format, no article-level selection, no `skipped` control.

## Findings

### F1 — An articles-query failure crashes the page instead of rendering its 500 state

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/dashboard/[id].astro:100
- **Detail**: When the article query fails, the handler sets `loadError = true` and status 500 but
  does not return. Execution continues into the shortlist build, where `clusters` is populated (that
  query succeeded) but `articlesByCluster` is empty, so `clusterArticles` is `[]`,
  `clusterArticles[0]` is `undefined`, and the next line dereferences
  `representative.polish_title` — an unhandled TypeError. The deliberate error handling three lines
  above is defeated by the code immediately after it, and the operator gets a crash rather than the
  intended failure view.
  `tsconfig.json` extends `astro/tsconfigs/strict`, which does not enable
  `noUncheckedIndexedAccess`, so the compiler types `clusterArticles[0]` as non-undefined and
  cannot see this.
  The same hazard is handled correctly in `src/worker/rank.ts:fetchDigestReadyItems`, which uses
  `.at(0)` and drops the row with the comment "the email is not worth a crash if it ever does" —
  the two sites made opposite calls on the identical edge case.
- **Fix**: Return early when `articlesError` is set, or make the representative lookup total:
  `const representative = clusterArticles.find(...) ?? clusterArticles.at(0);` then skip the
  cluster when it is undefined.
  - Strength: Restores the intended 500 rendering, and matches the defensive choice already made
    in `rank.ts` for the same "cluster with no articles" case.
  - Tradeoff: None meaningful — a few lines on an error path.
  - Confidence: HIGH — the flow is directly readable, and the missing `noUncheckedIndexedAccess`
    explains why it was not caught.
  - Blind spot: Not reproduced live; it needs the article query to fail while the cluster query
    succeeds, which no test currently forces.
- **Decision**: FIXED — src/pages/dashboard/[id].astro now uses `.at(0)` inside a `flatMap`, dropping a cluster with no articles instead of throwing.

### F2 — Redundant index on selection_item

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260829120000_selection_gate.sql:57
- **Detail**: `create index selection_item_selection_id_idx on selection_item (selection_id)`
  duplicates the leading column of the index Postgres already creates for
  `unique (selection_id, cluster_id)`. A query filtering on `selection_id` can use the unique
  index, so the extra index only costs write amplification and storage.
- **Fix**: Drop `selection_item_selection_id_idx` in a follow-up migration. If S-09 will query by
  `cluster_id` (the reverse direction, which nothing indexes today), add that index instead.
- **Decision**: FIXED — migration 20260906140000_selection_item_indexes.sql drops the redundant index and adds one on cluster_id. Applied to the cloud project via the SQL Editor 2026-09-06.

### F3 — Raw Postgres constraint message returned to the client on double-confirm

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/selection/confirm.ts:99
- **Detail**: `return fail(mapped.status, mapped.reason, error.message)` forwards the database's own
  message for every mapped code. For SG001-SG005 those are deliberate, operator-readable strings.
  For `23505` it is Postgres's own text — `duplicate key value violates unique constraint
  "selection_digest_id_key"` — which leaks a table and constraint name into the HTTP response. The
  unmapped branch immediately above is careful to keep raw Postgres text out of the response; the
  mapped branch is not. Low severity in a single-operator app behind the PIN gate.
- **Fix**: Give each `RPC_ERRORS` entry an explicit client-facing message and send that, keeping
  `error.message` for the `console.error` line only.
- **Decision**: FIXED — RPC_ERRORS entries now carry explicit client-facing messages; error.message is kept for the console.error line only.

### F4 — confirm_selection does not assert the shortlist is complete

- **Severity**: OBSERVATION
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260829120000_selection_gate.sql:139
- **Detail**: The function checks that every supplied shortlist id *is* a ranked cluster of the
  digest, but not that the supplied set *covers* all of them. A client sending 5 of 15 ids passes
  every check and writes only 5 `selection_item` rows. US-10's whole point — and this table's
  stated reason for existing — is that a 15-story shortlist yields 15 labeled examples, so a
  truncated request silently reduces S-09's training signal with no error anywhere.
  Passing the shortlist from the client is a deliberate, documented decision (what the operator
  actually saw is what gets labeled); this finding does not dispute that, only that the
  completeness half of the contract is unenforced.
- **Fix**: Add a count check — compare `v_shortlist_count` against
  `select count(*) from cluster where digest_id = p_digest_id and rank is not null`, raising SG005
  on mismatch.
  - Strength: Closes the gap without abandoning the client-supplied-shortlist design; a re-rank
    that changes the set surfaces as SG005 rather than silently under-labeling.
  - Tradeoff: Stricter requests — a legitimately stale page now fails where it previously
    succeeded with partial data. That is the intended direction, but it is a behavior change.
  - Confidence: MEDIUM — the check is easy, but whether a partial shortlist can arise depends on
    the island always sending every rendered item, which it does today.
  - Blind spot: No test constructs a truncated shortlist, so the failure mode is theoretical.
- **Decision**: FIXED via Fix A — migration 20260906141000_confirm_selection_complete_shortlist.sql adds the ranked-cluster count check (SG005). The rules.test.ts drift guard was split so enum assertions read the migration that declares them. Applied to the cloud project via the SQL Editor 2026-09-06; covered by confirm.test.ts "rejects a shortlist that omits some of the digest's ranked clusters", which passes against the live function.

### F5 — Catalan-source documentation describes a configuration that ended 2026-07-31

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: supabase/migrations/20260829130000_article_language.sql:31
- **Detail**: The backfill comment states "the operator enabled Ara and Nacio Digital, widening the
  translation scope from es->pl to {es,ca}->pl". Both sources were set `enabled: false` by commit
  `9fcaa75` on 2026-07-31, a month before this plan was written; `src/lib/collection/sources.ts`
  currently enables Spanish sources only. The plan inherited the claim from the roadmap's Open
  Roadmap Question #1, which is likewise stale.
  The backfill itself was correct and useful — 111 articles carry `language = 'ca'` from
  collections that ran before the narrowing, which is what made Phase 2's manual check 2.5 ("a
  Catalan-source story is flagged CA, not ES") genuinely verifiable. The issue is forward-looking:
  no new collection can produce a `ca` row, so the `CA` flag path is dead in practice while two
  documents assert otherwise.
- **Fix**: Correct the roadmap's OQ#1 resolution and S-03 scope note when S-04 is archived; decide
  separately whether the Catalan sources should be re-enabled (a product question, not a code fix).
- **Decision**: FIXED — roadmap OQ#1 and the S-03 scope note carry a dated correction; the migration comment records that the 'ca' branch is historical. Whether to re-enable the Catalan sources is left open as a product decision.

## Success Criteria

| Phase | Automated | Manual |
|-------|-----------|--------|
| 1 | pass | complete |
| 2 | pass | complete |
| 3 | pass | complete |
| 4 | pass | complete |
| 5 | pass | 5.4, 5.5, 5.7 complete; **5.6 deferred** |

5.6 ("the CTA opens the correct digest page through the tunnel hostname") cannot be verified
because no Cloudflare Tunnel host exists yet. It is recorded as deferred rather than passed — the
CTA is verified to render with the correct digest id against `http://localhost:4321`. It is the
only outstanding criterion in the slice.
