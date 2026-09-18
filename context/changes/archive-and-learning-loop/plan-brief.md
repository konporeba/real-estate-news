# Archive & Learning Loop (S-09) — Plan Brief

> Full plan: `context/changes/archive-and-learning-loop/plan.md`

## What & Why

Two connected pieces sharing one storage shape: (1) surface every digest's full editorial record —
which stories were picked and passed over, with the rubric's own score and reasoning — on the
pages that already render most of it, and (2) feed each week's picks-vs-passes back into the
ranking rubric as capped, eval-safe few-shot examples, so ranking converges on the operator's
actual taste (FR-025) instead of staying purely zero-shot forever.

## Starting Point

Direct code reading found more already built than the roadmap entry implied: `dashboard/[id].astro`
already renders all 15 shortlist items (picks marked, passes shown plain) for any digest past
ranking, and `dashboard/[id]/approve.astro` already renders full-fidelity read-only content
(copy, visuals, publish results) for any terminal digest. `selection_item` — built by S-04
specifically anticipating this slice — already stores every pick and pass. The rubric itself is
zero-shot today, with a written constraint that any future few-shot content must never overlap
the held-out eval set.

## Desired End State

Any past digest's shortlist shows tier, score, and rationale for all 15 stories, not just picks.
The dashboard list pages back through full history. Real ranking runs optionally score against a
rubric that includes a small, recent sample of the operator's real decisions — reversible with one
config flag, and mechanically guaranteed to never leak into the regression-eval set.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Archive scope | Every digest that reached selection or later | Matches FR-024's "every digest" wording and maximizes few-shot signal |
| Archive routing | Extend existing pages, no new route | `[id].astro` + `approve.astro` already cover it; forking would duplicate boilerplate |
| Pass detail | Title + tier + score + rationale | Data is already captured in `scoring_detail`; costs no new LLM calls |
| Retention (OQ#5) | Keep everything indefinitely | Storage is cloud (Supabase), footprint is negligible, matches existing design intent |
| Few-shot source | Query `selection_item` directly, no curation table | Storage shape was built for exactly this; matches "operator's actual taste" |
| Few-shot cap | Fixed cap, most recent N per label (N=8 default) | Bounds prompt-dilution and cache-cost growth over a multi-year horizon |
| Eval safety | Automated disjointness check inside the RANKING_EVAL gate | Turns rubric.ts's written promise into something mechanically enforced |
| Rollback | Config flag (`RANKING_FEWSHOT_ENABLED`) | Matches the harness's existing env-driven pattern; no deploy needed to react |
| Publication history | Keep latest-only, no schema change | Matches the most plausible reading of "per-platform results" as final outcome |
| Scope/priority | Ship both FR-024 and FR-025 together | Both are PRD must-haves, co-designed around the same storage shape |

## Scope

**In scope:**
- Score + rationale on shortlist cards
- Dashboard list pagination + status filter
- Few-shot retrieval from `selection_item`
- Wiring few-shot into the rubric prompt behind a kill-switch
- Automated eval-set disjointness guarantee
- Resolving roadmap OQ#5 in the docs

**Out of scope:**
- A curated/reviewed few-shot table
- Full publish-attempt history
- Image expiry/cleanup
- Any new dashboard route

## Architecture / Approach

Two tracks sharing one data source. Archive visibility (Phases 1-2) is additive UI work on
already-working pages. The learning loop (Phases 3-5) adds one new read module
(`src/lib/ranking/few-shot.ts`), threads its output into the existing rubric-prompt builder behind
a config flag, and adds a mechanical safety check inside the existing `RANKING_EVAL` gate so the
mechanism can never silently violate the rubric's own zero-shot-eval guarantee.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Score + rationale on shortlist cards | Full editorial reasoning visible on every shortlist item | Low — data already exists, purely additive |
| 2. Archive list pagination + filter | Full digest history browsable | Low — small, isolated page change |
| 3. Few-shot example retrieval | New query module over `selection_item` | Medium — must get the picked/passed split and cap right |
| 4. Wire few-shot into the rubric | Real ranking runs can use real examples | Medium-high — changes ranking behavior; needs the kill-switch |
| 5. Eval-set disjointness guarantee | Mechanical safety check | High stakes if skipped — this is what makes Phase 4 safe to ship |
| 6. End-to-end verification | Confirms both tracks work together; closes OQ#5 | Low — verification only |

**Prerequisites:** S-08 and S-02 both shipped (per roadmap); no new infrastructure needed.
**Estimated effort:** ~2-3 sessions across 6 phases — Phases 1-2 are small, Phases 3-5 are the
substantive engineering.

## Open Risks & Assumptions

- The few-shot cap (N=8 per label) is a reasoned starting point, not a validated number — may need
  tuning once real multi-week history accumulates.
- `RANKING_EVAL`'s disjointness check only catches overlap with the current 16-example eval set;
  if that set grows, the check still holds automatically, but nobody has stress-tested it against
  a larger eval set.
- No live smoke test covers the archive queries (deliberately, per the project's own test-tiering
  convention) — a real Supabase performance surprise at scale would only surface manually.

## Success Criteria (Summary)

- Any past digest's full editorial record (picks, passes, scores, rationale, copy, visuals,
  publish results) is browsable from the existing dashboard pages.
- `RANKING_EVAL=1 npm test` passes with real few-shot content wired in, proving both correctness
  and eval-set safety together.
- The operator can disable the few-shot mechanism instantly via config if it ever misbehaves.
