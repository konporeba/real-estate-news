# Translated Shortlist View Implementation Plan

## Overview

Build S-03, the digest pipeline's next unbuilt slice (named in the schema migration's own comments): translate each shortlisted story's headline to Polish, and give the operator a dashboard screen to review the translated top-15 shortlist. Two parts: a translation step added to the ranking worker, and two new authenticated Astro pages.

## Current State Analysis

- The schema already anticipates this work but nothing implements it: `article.polish_title`/`article.polish_summary` (`supabase/migrations/20260722173032_digest_core_schema.sql:82-83`) are nullable and unwritten by any code path, and `digest.translation_completed_at` (line 43) is a reserved checkpoint column with a `DigestStage` entry (`src/types.ts:12`) and a `STAGE_CHECKPOINT` handler (`src/lib/digest/run-state.ts:38`), but nothing ever calls `markStageComplete(..., "translation")`.
- `rankDigest()` (`src/lib/ranking/rank.ts:149-221`) clusters the article pool, scores each cluster via the geography rubric, persists `cluster.rank` 1-15 for the shortlist (`SHORTLIST_SIZE = 15`, line 23), and transitions the digest straight from `ranking` to `ready_for_selection` (line 217) — no translation happens in between.
- Source articles are Spanish/Catalan (`SOURCE_LANGUAGES = ["es","ca"]`, `src/lib/collection/sources.ts:29`).
- `digest_status` has no `translating` state (`supabase/migrations/20260722173032_digest_core_schema.sql:19-29`: `collecting → ranking → ready_for_selection → generating → ready_for_approval → approved → published/skipped/failed`) — translation was designed as a sub-step inside the `ranking` stage, not its own pipeline status.
- `src/pages/dashboard.astro` is a static placeholder (sign-out button only) behind the PIN gate. No other page reads `digest`/`cluster`/`article`.
- `PROTECTED_ROUTES = ["/dashboard"]` in `src/middleware.ts:7` matches by `startsWith`, so any nested route under `/dashboard` (e.g. `/dashboard/[id]`) is already gated.
- A `cluster` (story) has no title/description column of its own — the display text lives on the `article` rows it groups via `article.cluster_id`, and a cluster can cover multiple articles (`coverage_count`). There is no existing "representative article per cluster" concept.
- `invoke()` (`src/lib/llm/invoke.ts`) is the only sanctioned path to the LLM; `scoreClusters` (`src/lib/ranking/score-clusters.ts:71-102`) is the closest precedent for a batched structured call that echoes real ids back in its schema (not localized indices — that trick in `cluster.ts` exists only because clustering spans hundreds of articles).

### Key Discoveries:

- **No schema migration needed.** `polish_title`/`polish_summary`/`translation_completed_at` already exist; this change only starts writing to them.
- **The representative-article marker is implicit, not a new column.** Per the "representative article only" scope decision, at most one article per shortlisted cluster ever gets a non-null `polish_title` — so at read time, "does this article have a non-null `polish_title`" doubles as "is this the cluster's headline," with no schema change required.
- **The representative pick happens in-memory during ranking**, not by querying the DB after the fact: `persistClusters` (`src/lib/ranking/rank.ts:82-110`) already returns `{ id: clusterId, articleIds: string[] }[]` in clustering's original order, so `articleIds[0]` is available for free right where `rankDigest` already holds `pool.data` (article title/lede) and `ordered` (score-sorted clusters) in memory — no extra DB round trip to determine or fetch the representative.
- `rank.test.ts`'s `fakeTransport` (`src/lib/ranking/rank.test.ts:109-147`) is a **smart fake** that reads each request's prompt to answer dynamically, because clustering/scoring must echo DB-generated ids unknowable in advance. Adding translation to `rankDigest` means extending this fake with a third branch — a real article id, unlike cluster ids, IS known before the call, so the branch can be a simpler direct lookup.

## Desired End State

- Running `npm run rank` (or the scheduled "collection" job) on a digest with a non-empty pool leaves it in `ready_for_selection` with `polish_title`/`polish_summary` populated on the representative article of every shortlisted cluster, and `translation_completed_at` set.
- An authenticated operator visiting `/dashboard` sees a list of recent digests with their status; clicking one whose status is `ready_for_selection` or later opens `/dashboard/[id]`, showing the top-15 shortlist as cards with the Polish headline/summary, a geography-tier badge, a source count, and a link to the original article.
- A digest not yet past ranking (`collecting`/`ranking`) shows a "not ready yet" state on its detail page instead of a shortlist; a `failed` digest shows its `last_error`.

### Verification

- `npm test` passes, including the new integration suite (gated by `SUPABASE_TEST_PROJECT=1` per the project's existing convention).
- Manually: run `npm run collect` then `npm run rank` against a real (or seeded) digest, confirm `article.polish_title` is populated for shortlisted representatives, then load `/dashboard` and `/dashboard/[id]` in a browser and visually confirm the translated shortlist renders.

## What We're NOT Doing

- No selection/approval actions on the dashboard — this change is read-only. Moving a digest from `ready_for_selection` to `generating` is a separate future slice.
- No public/reader-facing route — the view is operator-only, behind the existing PIN gate.
- No translation of non-representative articles within a shortlisted cluster (e.g. "other sources covering this story" stay untranslated).
- No new `digest_status` enum value and no migration — translation is a sub-step of the existing `ranking` stage.
- No digest-history pagination beyond a simple capped list — if the list of digests grows large enough to need paging, that's a follow-up.
- No changes to the clustering or scoring prompts/schemas.

## Implementation Approach

Two independent, sequentially-buildable pieces:

1. **Worker side**: a new `translateShortlist()` module mirrors `scoreClusters()`'s invoke()-plus-zod-schema shape, called once (a single batched call for ≤15 items — no chunking/concurrency machinery needed at this scale, unlike `scoreClusters`' hundreds-of-clusters case). `rankDigest()` computes the representative article per shortlisted cluster from data it already holds in memory, calls `translateShortlist`, persists the results with a small helper (`persistTranslations`), stamps the `translation` checkpoint, and only then transitions to `ready_for_selection`. A translation failure fails the digest exactly like a clustering or scoring failure (`failDigest`, same message convention: `` `translation ${reason}: ${message}` ``).
2. **App side**: two Astro pages under the existing PIN gate, reading through `createServiceClient()` from `@/lib/supabase-admin` (the app-side privileged client, since RLS is deny-by-default on all three domain tables). No React — this is server-rendered, non-interactive display, per the "Astro for static content, React only for interactivity" convention.

## Phase 1: Translation stage in the ranking worker

### Overview

Add the LLM translation call and wire it into `rankDigest()` between the ranking checkpoint and the `ready_for_selection` transition.

### Changes Required:

#### 1. Translation module

**File**: `src/lib/ranking/translate-shortlist.ts` (new)

**Intent**: Given the representative articles of the shortlisted clusters (id, original title, original lede — lede may be `null`), make one batched `invoke()` call asking the model to translate each to Polish, and return the parsed translations keyed by article id. Mirrors `scoreClusters`' echo-real-id batch pattern (`src/lib/ranking/score-clusters.ts:35-39,104-134`), not `cluster.ts`'s localized-index trick — at ≤15 items, real UUIDs in the prompt/response cost nothing meaningful. When an article's `lede` is `null`, the prompt tells the model to translate the title only and return a `null` summary rather than inventing one.

**Contract**:

```ts
export interface TranslatableArticle {
  id: string;
  title: string;
  lede: string | null;
}

export async function translateShortlist(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  articles: TranslatableArticle[],
  options: { ceilingUsd: number },
): Promise<LlmResult<Map<string, { polishTitle: string; polishSummary: string | null }>>>
```

Empty `articles` returns `{ ok: true, data: new Map() }` without calling the model (mirrors `clusterArticles`/`scoreClusters`). The batch schema echoes `articleId` (a real id, `z.string()`) plus `polishTitle: z.string()` and `polishSummary: z.string().nullable()`; a response omitting a requested id is `malformed_output` (mirrors `scoreClusters`' completeness check, `src/lib/ranking/score-clusters.ts:91-99`) — a silently dropped translation would leave the dashboard falling back to the original-language text for that story with no diagnostic. `maxTokens` follows the same per-item-budget-plus-floor shape as `scoreClusters`' `MAX_TOKENS_PER_CLUSTER`/`MAX_TOKENS_FLOOR`.

#### 2. Wire into the ranking orchestrator

**File**: `src/lib/ranking/rank.ts`

**Intent**: After `persistRanking` and `markStageComplete(client, digest.id, "ranking")` (lines 211-215), and before the `transitionDigest(..., "ready_for_selection")` call (line 217): compute each shortlisted cluster's representative article from data already in memory, call `translateShortlist`, persist the results, and stamp the `translation` checkpoint. A `translateShortlist` failure routes through the existing `failDigest` helper, matching the clustering/scoring failure convention documented in this file's own header comment.

**Contract**: The representative article id per shortlisted cluster is `persisted.data`'s `articleIds[0]` (from `persistClusters`, line 91: `persisted: PersistedCluster[]`), looked up for the top `SHORTLIST_SIZE` entries of `ordered`. Add a `persistTranslations(client, translations: Map<string, {polishTitle, polishSummary}>)` helper alongside `persistClusters`/`persistRanking`, writing `polish_title`/`polish_summary` per article id — at ≤15 rows, plain concurrent `.update().eq("id", articleId)` calls (`Promise.all`), no new RPC needed (unlike `assign_articles_to_clusters`/`persist_cluster_rankings`, which exist because those write hundreds of rows).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Unit/integration tests pass: `SUPABASE_TEST_PROJECT=1 SUPABASE_SERVICE_ROLE_KEY=<key> npm test`
- New `translate-shortlist.test.ts` (integration-tier, mirrors `score-clusters.test.ts`) covers: a batched translation response parses into per-article results; a malformed/incomplete batch surfaces `malformed_output`; a ceiling hit surfaces `ceiling_reached`; an article with `lede: null` accepts a `null` `polishSummary`; an empty input list makes no LLM call.
- `rank.test.ts`'s `fakeTransport` gains a translation branch (matching on the translation prompt's distinguishing text) so the existing `rankDigest` integration tests keep passing end-to-end; extend the "moves a non-empty pool to ready_for_selection" test to assert the top-15 representative articles now have `polish_title`/`polish_summary` set, and add one new test asserting a translation failure fails the digest with a `last_error` matching `/translation/` (mirroring the existing "a ceiling hit during scoring fails the digest" test, `src/lib/ranking/rank.test.ts:233-252`).
- New `translate-shortlist.live.test.ts` opt-in live smoke test (mirrors `src/lib/llm/invoke.live.test.ts`), gated by e.g. `TRANSLATION_LIVE_SMOKE=1 SUPABASE_TEST_PROJECT=1`: one real call translating a short Spanish title+lede, asserting the response parses and the Polish text is non-empty and differs from the input — not a translation-quality assertion, just that the real API's response still matches the schema this module assumes.

#### Manual Verification:

- Run `npm run collect` then `npm run rank` against a digest with real Spanish/Catalan articles; confirm the console output still ends with the expected shortlist summary and the digest reaches `ready_for_selection`.
- Query the `article` table for that digest's shortlisted representatives and visually confirm `polish_title`/`polish_summary` read as sensible Polish translations, not garbled or truncated text.
- Confirm `digest.cost_usd` increased by a plausible small amount for the added translation call.

---

## Phase 2: Dashboard digest list page

### Overview

Replace the placeholder `/dashboard` with a list of recent digests, linking into each one's detail page.

### Changes Required:

#### 1. Shared operator header

**File**: `src/components/OperatorHeader.astro` (new)

**Intent**: Extract the existing "Operator Dashboard" heading + sign-out form (currently the whole body of `dashboard.astro`) into a small reusable Astro component so both the list and detail pages share it instead of duplicating the sign-out `<form>`.

**Contract**: Accepts a `title` prop (the page-specific heading, e.g. "Operator Dashboard" or a digest's date range); renders the same glass-card chrome and sign-out button `dashboard.astro` (`src/pages/dashboard.astro:6-19`) already has.

#### 2. Digest list page

**File**: `src/pages/dashboard.astro`

**Intent**: Query recent digests and render each as a row/card with its week window and status, linking to `/dashboard/[id]`.

**Contract**: Server-side query via `createServiceClient()` (`@/lib/supabase-admin`) — handle the `null` (unconfigured) case with a visible message rather than throwing. `client.from("digest").select("id, window_start, window_end, status, created_at").order("window_start", { ascending: false }).limit(25)`. Each row links to `/dashboard/${id}`; status renders as a small label (no need for the tier-badge color system from Phase 3 — a plain text status is enough here).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- Sign in via the PIN gate, land on `/dashboard`, and confirm it lists digests ordered newest-first with correct statuses, each linking to its detail page.
- With zero digests in the table, confirm the page renders an empty state rather than erroring.
- Sign out from the list page and confirm the redirect to `/auth/pin` still works.

---

## Phase 3: Dashboard shortlist detail page

### Overview

The actual "translated shortlist view": `/dashboard/[id]` shows one digest's top-15 stories with their Polish headline/summary.

### Changes Required:

#### 1. Shortlist detail page

**File**: `src/pages/dashboard/[id].astro` (new)

**Intent**: Fetch the digest by id; if its status is before `ready_for_selection` (`collecting`/`ranking`), show a "not ready yet" state; if `failed`, show `last_error`; otherwise fetch and render the top-15 shortlist as cards.

**Contract**: Fetch `cluster` rows for the digest with `rank` non-null, ordered by rank (mirrors `fetchShortlist` in `src/worker/rank.ts:84-93`, but from the Astro/service-client side). For those cluster ids, fetch `article` rows (`id, cluster_id, source_name, source_url, published_at, original_title, original_lede, polish_title, polish_summary`) and pick each cluster's representative as the article with a non-null `polish_title` if one exists, else the earliest by `published_at` as a defensive fallback (covers a pre-existing digest ranked before this feature shipped, or the rare case translation degraded per-item). Each card shows: `polish_title` (falling back to `original_title` if null), `polish_summary` (falling back to `original_lede`), a tier badge from `scoring_detail.tier` (`catalonia`/`national`/`global`/`discard` — four colors, extending the three-tier palette concept from `src/lib/email/layout.ts:107-111` since the dashboard's tier set includes `discard`, unlike email's generic `high`/`medium`/`low`), `coverage_count` as a "N sources" label, and a link to `source_url`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- Open a `ready_for_selection` digest's detail page and confirm all 15 (or fewer) shortlist items render with Polish text, correct tier badges, source counts, and working links to the original article.
- Open a `collecting`/`ranking` digest and confirm the "not ready yet" state renders instead of an empty or broken shortlist.
- Open a `failed` digest and confirm its `last_error` is shown.
- Visit `/dashboard/<a nonexistent id>` and confirm a sensible not-found response rather than a crash.

---

## Testing Strategy

### Unit/Integration Tests:

- `translate-shortlist.test.ts` — batched parsing, incomplete-batch `malformed_output`, `ceiling_reached`, `null` lede handling, empty input.
- `rank.test.ts` — extended fake transport covers the translation call; assert translated fields land on the right article; assert a translation failure fails the digest.

### Live Smoke Test:

- `translate-shortlist.live.test.ts`, opt-in, one real call, asserts schema shape and non-trivial output — not translation quality.

### Manual Testing Steps:

1. Run `npm run collect` then `npm run rank` on a real digest.
2. Confirm shortlisted representative articles have Polish text in the database.
3. Load `/dashboard`, confirm the digest list, click into the ranked digest.
4. Confirm the shortlist detail page renders translated cards with tier badges, source counts, and working source links.
5. Try a not-yet-ranked digest and a `failed` digest to confirm their respective non-shortlist states.

## Performance Considerations

One additional `invoke()` call per ranking run, sized for ≤15 short title+lede pairs — negligible next to the clustering/scoring calls already in the same run, and covered by the same per-digest `LLM_COST_CEILING_USD`.

## Migration Notes

None — `polish_title`, `polish_summary`, and `translation_completed_at` already exist in the schema from F-01; this change is the first to write to them.

## References

- Change folder: `context/changes/translated-shortlist-view/`
- Ranking orchestrator: `src/lib/ranking/rank.ts:149-221`
- Batched-translation precedent: `src/lib/ranking/score-clusters.ts:71-134`
- Email tier-badge precedent: `src/lib/email/layout.ts:97-183`
- PIN gate: `src/middleware.ts`, `src/pages/auth/pin.astro`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Translation stage in the ranking worker

#### Automated

- [x] 1.1 Type checking passes: `npm run lint`
- [x] 1.2 Unit/integration tests pass: `SUPABASE_TEST_PROJECT=1 npm test`
- [x] 1.3 `translate-shortlist.test.ts` covers batching, malformed/incomplete batch, ceiling, null lede, empty input
- [x] 1.4 `rank.test.ts` fake transport extended; translation-failure test added
- [x] 1.5 `translate-shortlist.live.test.ts` opt-in live smoke test added

#### Manual

- [x] 1.6 `npm run collect` + `npm run rank` against real articles completes and reaches `ready_for_selection`
- [x] 1.7 Shortlisted representative articles show sensible Polish translations in the database
- [x] 1.8 `digest.cost_usd` increased by a plausible small amount

### Phase 2: Dashboard digest list page

#### Automated

- [ ] 2.1 Type checking passes: `npm run lint`
- [ ] 2.2 Build succeeds: `npm run build`

#### Manual

- [ ] 2.3 `/dashboard` lists digests newest-first with correct statuses and working links
- [ ] 2.4 Empty digest table renders an empty state, not an error
- [ ] 2.5 Sign-out from the list page still redirects to `/auth/pin`

### Phase 3: Dashboard shortlist detail page

#### Automated

- [ ] 3.1 Type checking passes: `npm run lint`
- [ ] 3.2 Build succeeds: `npm run build`

#### Manual

- [ ] 3.3 `ready_for_selection` digest detail page renders translated cards with tier badges, source counts, links
- [ ] 3.4 Not-yet-ranked digest shows "not ready yet" state
- [ ] 3.5 Failed digest shows its `last_error`
- [ ] 3.6 Nonexistent digest id shows a sensible not-found response
