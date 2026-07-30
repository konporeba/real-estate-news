# Translated Shortlist View — Plan Brief

> Full plan: `context/changes/translated-shortlist-view/plan.md`

## What & Why

Build S-03 — the digest pipeline's next unbuilt slice, named in the schema's own migration comments. Source articles are collected in Spanish/Catalan; the operator needs to review the weekly top-15 shortlist in Polish before the pipeline moves on to content generation. Today neither the translation nor any shortlist UI exists.

## Starting Point

`rankDigest()` already clusters, scores, and ranks the top-15 shortlist, transitioning the digest straight to `ready_for_selection` — with no translation step. The schema was already primed for this: `article.polish_title`/`polish_summary` and `digest.translation_completed_at` exist but are unwritten by any code. `/dashboard` is a static placeholder behind the PIN gate; no page reads digest/cluster/article data.

## Desired End State

After `npm run rank` completes, the shortlisted stories' representative articles carry Polish translations. An operator signs in at the existing PIN gate, sees a list of recent digests on `/dashboard`, and opens any ranked one to see its top-15 shortlist as cards — translated headline and summary, a geography-tier badge, a source count, and a link to the original article. Read-only; no selection/approval actions yet.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| When translation runs | Inline inside `rankDigest()`, before the `ready_for_selection` transition | Matches the existing checkpoint design (no new `digest_status` value needed) and the scheduler already chains collect→rank as one job |
| Representative article per cluster | First article id in the cluster's group (`articleIds[0]`), picked in-memory during ranking | Zero new schema/columns — the data already exists where `rankDigest` already holds it |
| Translation granularity | Representative article only (≤15 items) | Matches the shortlist view's actual scope; minimal LLM spend |
| Translated summary content | Direct translation of `original_lede`, not a fresh summary | Translation is a much safer LLM task than summarization — lower risk of dropped/invented facts |
| Translation failure handling | Fails the whole digest, same as clustering/scoring failures | Consistent with `rank.ts`'s own documented convention; keeps "reached `ready_for_selection`" meaning "fully translated" |
| View access & scope | Operator-only (existing PIN gate), read-only | Matches the migration's own scope note separating "shortlist view" from a later selection slice |
| Digest picker | List/history page, not just "latest" | Lets the operator revisit past weeks, not only the current cycle |
| Display fields | Translated headline/summary + tier badge + source count + link to original | Gives the operator enough context to sanity-check the ranking, not just a bare headline |
| Testing | Mocked/integration unit tests + one opt-in live smoke test | Matches the repo's established per-LLM-call-site testing convention |

## Scope

**In scope:**
- Translation step inside the ranking worker (`translateShortlist`, wired into `rankDigest`)
- `/dashboard` — list of recent digests
- `/dashboard/[id]` — translated top-15 shortlist detail view
- Integration tests + one opt-in live smoke test for the translation call

**Out of scope:**
- Selection/approval actions (moving a digest to `generating`)
- Public/reader-facing route
- Translating non-representative articles within a cluster
- New `digest_status` enum value or migration
- Digest-list pagination beyond a simple capped list

## Architecture / Approach

Two independent pieces: (1) a new `src/lib/ranking/translate-shortlist.ts` module, mirroring `scoreClusters`'s batched `invoke()` + zod-schema pattern, called once per ranking run for ≤15 items and wired into `rank.ts` right before the digest transitions to `ready_for_selection`; (2) two server-rendered Astro pages under the existing PIN gate, reading `digest`/`cluster`/`article` through the privileged service-role client (`createServiceClient()` from `@/lib/supabase-admin`) — no React, since nothing here needs client-side interactivity.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Translation stage | Ranking worker writes Polish `polish_title`/`polish_summary` for shortlisted representatives before reaching `ready_for_selection` | A translation failure now fails an otherwise-good ranking run — acceptable per the chosen failure strategy, but worth watching in practice |
| 2. Dashboard digest list | `/dashboard` shows recent digests with status, linking into each | Low risk — simple read-only list |
| 3. Dashboard shortlist detail | `/dashboard/[id]` shows the translated top-15 with tier badges, source counts, links | Picking a sensible representative-article fallback when no translation exists (legacy/edge case) needs to be genuinely deterministic |

**Prerequisites:** None beyond what's already in the repo — no new env vars, no migration.
**Estimated effort:** ~3 sessions, one per phase.

## Open Risks & Assumptions

- Assumes a shortlisted cluster's "first assigned article" is a reasonable enough proxy for "best representative" — no curation/quality signal beyond clustering order. Acceptable per the chosen scope, but worth revisiting if operators find odd headlines chosen.
- A translation failure now costs an otherwise-successful ranking run's LLM spend (clustering + scoring already ran). Accepted trade-off per the "fail the digest" decision, consistent with how clustering/scoring failures already behave.
- No real production digests likely exist yet in `ready_for_selection` — manual verification may need a seeded/test digest rather than the current live pipeline state.

## Success Criteria (Summary)

- A ranking run produces Polish translations for every shortlisted story's representative article, or fails the digest with a clear diagnostic.
- An operator can sign in, browse recent digests, and read a fully translated top-15 shortlist with enough context (tier, source count, link) to sanity-check the ranking.
