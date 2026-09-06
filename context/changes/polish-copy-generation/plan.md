# Polish Copy Generation (S-05) Implementation Plan

## Overview

Build the pipeline's generation stage. The operator has passed the S-04 gate: 2–4 clusters are picked, a format and platform set are chosen, and the digest sits in `generating` with nothing to advance it. This slice fetches each selected story's real source text, adapts it into Polish social copy through the F-03 harness, deterministically asserts that every significant source numeral survived the adaptation, persists the result, and transitions the digest to `ready_for_approval`.

Roadmap slice S-05. PRD refs: FR-013, FR-014, FR-016, FR-017, US-11, US-12, US-15.

## Current State Analysis

- **The digest reaches `generating` and stops.** `src/lib/digest/state-machine.ts:17` allows `generating → ready_for_approval | failed`, and `confirm_selection` transitions into `generating`, but no worker consumes that state. Digest `c92aa3c5` will sit there the moment a selection is confirmed — exactly as S-01 left digests in `ranking` before S-02 existed.
- **The table does not exist.** `supabase/migrations/20260722173032_digest_core_schema.sql:15` records that `selection` / `generated_asset` / `publication` / `feedback_label` are "deliberately NOT created here". S-04 took the selection half; this slice owns generated copy.
- **The source material is far thinner than FR-013 assumes.** `article` stores only `original_title` and `original_lede` (schema line 73). Measured against the live 108-article pool: **median lede 184 characters**, p10 103, p90 426, and 2 of 108 empty. FR-013 asks for "longer body copy for slides" and "pulled-out key statistics" — neither is reachable from two sentences without the model inventing material, which is precisely what FR-014 exists to catch.
- **There is no HTML parser in the project.** `toPlainText` (`src/lib/collection/adapters/rss.ts:38`) is a regex tag-stripper written for RSS snippets. Pointed at a full page it returns navigation, cookie banners and script bodies as "text".
- **There is no reusable HTTP helper.** `rss-parser` does its own fetching with a timeout and User-Agent (`rss.ts:33-34`); nothing else in the codebase fetches a URL.
- **`digest` has no generation checkpoint.** Only `collection_completed_at`, `ranking_completed_at`, `translation_completed_at` exist (schema lines 41-43). `DigestStage` and `STAGE_CHECKPOINT` in `src/lib/digest/run-state.ts` enumerate exactly those three.
- **The orchestrator convention is settled and must be copied.** `src/lib/ranking/rank.ts:1-12`: an infrastructure failure (a Postgres error mid-run) returns raw; a *genuine* failure transitions the digest to `failed` with `last_error` and still returns `ok: true` — the stage ran to completion, it just concluded the digest cannot proceed. Callers inspect `outcome.data.digest.status` to tell them apart.

## Desired End State

Running `npm run generate` on a digest in `generating` produces one `generated_copy` row per picked cluster, each carrying a Polish title, a caption-ready summary, body copy sized for the confirmed format, and 3–5 pulled-out key statistics — then leaves the digest in `ready_for_approval`. Every significant numeral in each story's source text (currency amounts, percentages, and numbers carrying a unit or magnitude word) is present in that story's generated copy, verified by a deterministic check that runs after the model, not by asking the model to promise it. A story whose source page cannot be fetched or parsed is generated from its stored title + lede instead and is flagged as such on its row. Any story that fails the numeric gate after its corrective retry fails the whole digest to `failed` with a diagnostic naming the missing figures.

Verify by: confirming a selection on a real digest, running `npm run generate`, and reading the four Polish posts against their Spanish sources — every price and percentage in the copy traceable to the article, and the digest in `ready_for_approval`.

### Key Discoveries:

- **`database.types.ts` cannot be regenerated.** Its header records that gen-types returns "account does not have the necessary privileges" for this project; six migrations have been hand-added. Every schema change here must be hand-added the same way and appended to that header's EXCEPTION list.
- **Migrations are applied by hand through the Supabase SQL Editor**, not `db push` — the F-01 carried-forward note, now four migrations wide. Write the file, apply the SQL manually, then hand-edit the types.
- **Sonnet 5 runs adaptive thinking by default, and `maxTokens` caps thinking plus output combined** (`src/lib/llm/invoke.ts:47-52`, and the S-02 archive lesson). Generation is a creative task that benefits from thinking, so it stays enabled — which means `maxTokens` must be sized with real headroom above the visible output, or the copy truncates silently.
- **Boilerplate numerals poison the numeric gate.** The gate's source-of-truth is whatever text is sent to the model. If extraction leaks "© 2024", a phone number, or "3 comentarios", FR-014 will demand those appear in the Polish copy and fail a good run. Extraction quality is therefore a correctness concern, not a nicety — this is why the proven algorithm is worth two dependencies.
- **The project has an explicit no-User-Agent-spoofing policy.** `src/lib/collection/sources.ts:163` records that a 403-ing source is "deliberately NOT worked around by spoofing a browser" User-Agent. Article fetching must honour that: identify honestly and accept the lede-only fallback when refused.
- **`@/lib/collection/*` is importable from worker code.** `eslint.config.js` restricts app code from importing it, not worker code. `src/lib/generation/` is worker-side, so reusing `toPlainText` is permitted — though this plan uses it only for whitespace/entity tidying, never as the extractor.
- **The pick set is small.** 2–4 stories per week caps every cost here: 2–4 fetches, 2–4 LLM calls, 2–4 rows. Decisions that would be wrong at n=250 (per-item calls, delete-and-regenerate) are correct at n=4.

## What We're NOT Doing

- **No visual assets.** FR-015 and per-platform image generation are S-06. This slice writes text only.
- **No approval UI, no approval email.** S-07 owns `ready_for_approval` rendering and FR-019's notification. This slice only puts the digest into that state.
- **No per-platform copy variants.** FR-013 specifies one adaptation per story; per-platform difference lives in S-06's templates.
- **No copy-quality eval harness.** `RANKING_EVAL` gates the geography rubric because a tier has a right answer; "good social copy" does not. Quality is judged by the operator reading real output.
- **No operator-editable voice.** The voice prompt is a version-controlled constant, not a settings row with an editing UI.
- **No scheduler integration.** Generation follows a human gate and cannot join the Sunday chain. `npm run generate` is manual, exactly as S-01 and S-02 shipped before F-05 automated them.
- **No few-shot from past posts.** Nothing has ever published; this becomes possible after S-08 and belongs to S-09's learning loop.
- **No re-collection or article-body storage.** Bodies are fetched at generation time for the 2–4 selected stories and are not written back to `article`.
- **No migration-history repair.** The F-01 debt is pre-existing and stays out of scope.

## Implementation Approach

Bottom-up, so each phase is independently verifiable and nothing is built against an interface that does not exist yet.

The schema goes first because it carries the shape S-06 and S-07 will read. Then the two pure modules — the numeric gate and the text extractor — both of which are plain functions with no LLM and no database, and are therefore the cheapest things in the slice to test exhaustively. The gate precedes generation deliberately: it is the requirement with an actual right answer, and it is the part that fails silently and dangerously if wrong. Generation follows, then the orchestrator that composes everything and owns the digest transition, then the worker entrypoint.

## Critical Implementation Details

**The gate runs against the text the model was given, not the page.** Extract numerals from the exact string passed into the prompt, so the check is reproducible from stored inputs and a change in extraction can never make the gate assert figures the model never saw.

**Thinking stays enabled for generation, unlike clustering.** `clusterArticles` sets `thinking: false` because a mechanical partition needs no deliberation and the budget was being eaten by hidden reasoning. Copywriting is the opposite case — leave the default on, and size `maxTokens` well above the visible output so thinking does not truncate the response.

**The whole stage runs after a human gate, so cost is not the binding constraint — correctness is.** The F-03 ceiling still applies and still halts the run, but at 2–4 calls a week the realistic spend is cents; do not trade determinism for token savings anywhere in this slice.

## Phase 1: Generated-copy schema

### Overview

Create the table that holds one adapted story, plus the digest checkpoint the stage needs, following the deny-by-default RLS convention every prior migration establishes.

### Changes Required:

#### 1. Generated-copy migration

**File**: `supabase/migrations/20260906150000_generated_copy.sql`

**Intent**: Add the table S-06 and S-07 will read, and the `generation_completed_at` checkpoint the digest is missing.

**Contract**:

- Table `generated_copy`: `id` uuid pk; `digest_id` uuid not null references `digest` on delete cascade; `cluster_id` uuid not null references `cluster` on delete cascade; `polish_title` text not null; `caption_summary` text not null; `body_copy` text not null; `key_statistics` jsonb not null; `source_text_origin` text not null with a check constraint over `('article', 'lede')`; `source_char_count` int; `created_at` timestamptz not null default now(); `unique (digest_id, cluster_id)`.
- `source_text_origin` records whether the copy rests on a fetched article body or the lede-only fallback — S-07 surfaces it so the operator knows why a post reads short, and it is the diagnostic for a source that has started blocking us.
- `key_statistics` as jsonb holding an array of `{ label, value }` objects: a statistic is a pair, the count varies 3–5, and neither S-06's slot filling nor S-07's rendering needs to query inside it.
- `alter table digest add column generation_completed_at timestamptz`.
- RLS enabled on `generated_copy` with no policies — deny-by-default, service-role only, matching `selection` / `digest` / `cluster` / `article`.
- Index on `digest_id`.

#### 2. Run-state stage vocabulary

**File**: `src/lib/digest/run-state.ts`

**Intent**: Teach `markStageComplete` about the new checkpoint so the generation stage can record completion the way collection and ranking do.

**Contract**: `DigestStage` gains `"generation"`; `STAGE_CHECKPOINT` gains the corresponding `generation_completed_at` writer. No behavior change to existing stages.

#### 3. Generated types

**File**: `src/db/database.types.ts`

**Intent**: Hand-add the new table and column, since gen-types is unavailable on this project.

**Contract**: `generated_copy` under `public.Tables` in Row/Insert/Update shape; `digest.generation_completed_at: string | null` in all three shapes; the header's EXCEPTION list gains this migration.

#### 4. Shared types

**File**: `src/types.ts`

**Intent**: Expose the row type and the statistic shape the app and worker both name.

**Contract**: `GeneratedCopyRow` derived from `Database`, plus a `KeyStatistic` interface (`label: string; value: string`) and a `SourceTextOrigin` union.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass: `npm run build`
- No test regressions: `npm test`

#### Manual Verification:

- The migration applies cleanly through the Supabase SQL Editor
- `select * from generated_copy` succeeds with the service role and is denied with the anon key
- Inserting two rows with the same `(digest_id, cluster_id)` is rejected

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 2: Numeric-integrity module (FR-014)

### Overview

The deterministic gate, built as a pure function with no LLM and no database so it can be tested exhaustively and cheaply. This is the phase where rigor pays: it is the requirement with a right answer, and the one that fails dangerously if wrong.

### Changes Required:

#### 1. Numeral extraction and normalization

**File**: `src/lib/generation/numerals.ts`

**Intent**: Extract the significant figures from a Spanish/Catalan source text and from Polish output, reduced to a comparable canonical form, so drift is detectable across two locales that format numbers differently.

**Contract**: `extractFigures(text: string): Figure[]` where `Figure` is `{ raw: string; value: number; kind: "currency" | "percentage" | "magnitude" }`.

Significant figures only — a bare integer in prose is ignored; a number qualifies when it carries a currency symbol or code, a percent sign, a unit (`m²`, `km`), or a magnitude word (`millones`, `millón`, `mil`, `milions`, `mln`, `tys.`). This targets the classes FR-014 names and keeps incidental digits (article ids, "5 min", bylines) out of the assertion set.

Normalization must handle: Spanish thousands-dot / decimal-comma (`1.234,56`), Polish thousands-space (`1 234,56`), non-breaking and narrow-nobreak spaces inside numbers, a symbol on either side (`€1.234` and `1.234 €`), and magnitude words scaling the value (`3,5 millones` → 3_500_000) so a Polish `3,5 mln` matches a Spanish `3,5 millones`.

**Contract**: `assertFiguresPresent(source: Figure[], output: string): FigureCheck` returning `{ ok: true } | { ok: false; missing: Figure[] }`. A source figure is satisfied when a figure of equal canonical value appears in the output; comparison is on value, not on formatting. Float comparison uses an epsilon — `3,5 millones` and `3 500 000` must compare equal.

#### 2. Numeral module tests

**File**: `src/lib/generation/numerals.test.ts`

**Intent**: Cover the normalizer exhaustively; this is where the slice's testing effort concentrates.

**Contract**: Table-driven cases across both locales — Spanish and Polish separators; currency before and after the number; percentages including decimals; magnitude words in Spanish, Catalan and Polish; ranges (`entre 1.000 y 2.000 €` yields two figures); years and article ids correctly *not* extracted; a drifted figure (`1.234` → `1.243`) reported missing; a reformatted-but-equal figure reported present; empty and numeral-free text.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass: `npm run build`
- Numeral suite passes: `npm test`

#### Manual Verification:

- Running `extractFigures` over a real Spanish article's text yields the figures a human would call the story's key numbers, and nothing from the page furniture

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 3: Article text extraction

### Overview

Give generation real source material. Fetch the selected story's page and extract its readable body, with an explicit, typed fallback to the stored lede when that is not possible.

### Changes Required:

#### 1. Dependencies

**File**: `package.json`

**Intent**: Add the extraction stack. Both are worker-side, like `rss-parser` and `nodemailer`, and never reach the Cloudflare bundle.

**Contract**: `@mozilla/readability` and `linkedom` as dependencies.

#### 2. Fetch and extract

**File**: `src/lib/generation/source-text.ts`

**Intent**: Turn a `source_url` into article text, or say clearly that it could not.

**Contract**: `fetchArticleText(url: string, options?: { timeoutMs?: number }): Promise<SourceTextResult>` returning `{ ok: true; text: string; origin: "article" } | { ok: false; reason: "blocked" | "not_found" | "unparseable" | "too_short" | "network" }`. Never throws.

Identify honestly in the User-Agent — `sources.ts:163` records that spoofing a browser to defeat a 403 is a deliberate non-goal, and a source that refuses us takes the lede fallback rather than an evasion. Fetch with an `AbortSignal` timeout. Non-2xx maps to `blocked` (401/403/429) or `not_found` (404) or `network`. Parse with linkedom, run Readability, and treat a null result or a body below a minimum length as `unparseable` / `too_short` — Readability legitimately returns null on unusual layouts, and a 200-character "article" is boilerplate, not content. Tidy the extracted text through `toPlainText` for entities and whitespace only.

#### 3. Extraction tests

**File**: `src/lib/generation/source-text.test.ts`

**Intent**: Cover the failure taxonomy against fixtures, with no network access.

**Contract**: A realistic article fixture extracts body text and excludes nav/footer/comment markup present in the same fixture; a 403 yields `blocked`; a 404 yields `not_found`; markup Readability cannot parse yields `unparseable`; a very short body yields `too_short`; a fetch rejection yields `network` rather than throwing.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass, with the new dependencies resolving in the worker: `npm run build`
- Extraction suite passes: `npm test`

#### Manual Verification:

- Fetching a real Expansión or El País article URL returns the article body without navigation, cookie banner, or related-links text
- Fetching an Idealista URL degrades to a typed failure rather than hanging or throwing
- The figures `extractFigures` finds in that real extracted text contain no page-furniture numerals

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 4: Copy generation

### Overview

The model call: one story in, one structured adaptation out, through the F-03 harness.

### Changes Required:

#### 1. Voice prompt

**File**: `src/lib/generation/prompt.ts`

**Intent**: Encode US-11's "adapted for social media, not a literal translation" as a reviewable, version-controlled constant — the same shape as `GEOGRAPHY_RUBRIC_SYSTEM`.

**Contract**: `GENERATION_SYSTEM` naming the audience (Polish investors in the Barcelona/Catalonia property market), the register, the requirement to write Polish that reads natively rather than as translated Spanish, and an explicit instruction to carry every figure through unchanged — the model should try to satisfy the gate even though the gate, not the prompt, is what enforces it. Plus `buildGenerationPrompt(story, format)` producing the user message from the story's title, source text, and confirmed format.

#### 2. Generation call

**File**: `src/lib/generation/generate-copy.ts`

**Intent**: One `invoke()` call per story with a zod schema, so a malformed or gate-failing story is retried in isolation.

**Contract**: `generateCopy(llm, db, digestId, story, options): Promise<LlmResult<GeneratedCopy>>` where the schema yields `{ polishTitle, captionSummary, bodyCopy, keyStatistics: { label, value }[] }`.

Named constants this module owns: `GENERATION_MODEL` (Sonnet 5, `DEFAULT_MODEL` — set as its own constant so the Opus comparison recorded in the roadmap is a one-line change), `CAROUSEL_SLIDES = 5` (PRD OQ#3 is unresolved; five is a starting point and S-06 builds templates against it), `KEY_STATISTICS_MIN/MAX = 3/5`.

`bodyCopy` is a single text field for `single_post`, and for `carousel` is the slide bodies separated by a documented delimiter, so S-06 can split without a schema change. Leave `thinking` at its default (enabled) and size `maxTokens` with headroom above the expected visible output.

#### 3. Generation tests

**File**: `src/lib/generation/generate-copy.test.ts`

**Intent**: Cover control flow against a fake LLM transport, not copy quality.

**Contract**: Using `fakeLlmTransport`, a successful call returns the parsed shape; a `ceiling_reached` result propagates unchanged rather than throwing; the carousel format requests slide-structured body copy and the single-post format does not; the prompt contains the story's source text.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass: `npm run build`
- Generation suite passes: `npm test`

#### Manual Verification:

- One real call on a real story produces Polish that reads as native social copy rather than translated Spanish
- The pulled-out statistics correspond to figures actually in the source

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 5: Generation orchestrator

### Overview

Compose the stage and own the digest transition, following `rank.ts`'s failure convention exactly.

### Changes Required:

#### 1. Stage orchestrator

**File**: `src/lib/generation/generate.ts`

**Intent**: Everything between "a digest exists in `generating`" and "the digest is in `ready_for_approval` or `failed`".

**Contract**: `generateDigest(llm, db, digest, options: { ceilingUsd: number }): Promise<RunStateResult<GenerateOutcome>>` where `GenerateOutcome` is `{ digest: DigestRun; storyCount: number }`.

Sequence: read the confirmed `selection` and its picked `selection_item` rows (picked = true) joined to their clusters' representative articles → delete any existing `generated_copy` rows for the digest (re-runs regenerate from scratch, mirroring `clearExistingClusters`) → for each picked story, fetch source text with the lede fallback, generate, then run the numeric gate → persist all rows → `markStageComplete(db, id, "generation")` → transition to `ready_for_approval`.

The gate gets one corrective retry per story: on failure, re-invoke naming the specific missing figures, mirroring `clusterArticles`'s partition retry. A second failure is a genuine failure — transition the digest to `failed` with `last_error` naming the story and the missing figures, and return `ok: true`.

Follow the convention verbatim: infrastructure errors (Postgres) return raw; genuine failures (no confirmed selection, no picked stories, an LLM error including a ceiling hit, a gate failure after retry) transition to `failed` and still return `ok: true`. A fetch failure is *not* a genuine failure — it takes the lede fallback and records `source_text_origin = 'lede'`.

#### 2. Orchestrator tests

**File**: `src/lib/generation/generate.test.ts`

**Intent**: Cover the paths the last two impl-reviews found bugs in — failure branches and re-runs.

**Contract**: Integration tests against the real database with a fake LLM transport, in their own synthetic window year (3000, following the 2991–2999 convention). A happy path writes one row per picked story and lands the digest in `ready_for_approval`; a gate failure after retry lands it in `failed` with a diagnostic and writes no rows; a fetch failure still produces a row with `source_text_origin = 'lede'`; a re-run deletes prior rows rather than duplicating; a ceiling hit fails the digest rather than throwing; a digest with no confirmed selection fails with a clear message.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass: `npm run build`
- Orchestrator suite passes: `npm test`

#### Manual Verification:

- A digest whose source pages all fetch cleanly produces four rows with `source_text_origin = 'article'`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 6: `npm run generate` entrypoint

### Overview

The operator-facing command, mirroring `npm run rank` so the three stages share one shape.

### Changes Required:

#### 1. Worker entrypoint

**File**: `src/worker/generate.ts`

**Intent**: Resolve the target digest, run the stage, and report the outcome — a plain function that never calls `process.exit` itself, so it composes in-process like `collect.ts` and `rank.ts`.

**Contract**: `main(argv)` returning an exit code. Targets `--digest=<uuid>` if given, else the newest digest in `generating`. Exits 2 when refusing a digest not in `generating`, with a message naming the actual status — the `RankRefused` pattern. Prints each generated story's Polish title and its `source_text_origin`, and the run's cost.

#### 2. Script wiring

**File**: `package.json`, `CLAUDE.md`

**Intent**: Register the command and document it beside `collect` and `rank`.

**Contract**: `"generate": "tsx --env-file=.env src/worker/generate.ts"`, and a CLAUDE.md Commands entry describing the targeting rules and the exit-2 refusal.

#### 3. Entrypoint tests

**File**: `src/worker/generate.test.ts`

**Intent**: Cover flag parsing and target resolution, mirroring `rank.test.ts`.

**Contract**: `--digest=` parsing including a malformed uuid; resolution refuses a digest not in `generating`; resolution picks the newest when no flag is given.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check and build pass: `npm run build`
- Full suite passes: `npm test`

#### Manual Verification:

- `npm run generate` on a confirmed digest produces 2–4 Polish posts and leaves it in `ready_for_approval`
- `npm run generate` on a digest not in `generating` exits 2 with a clear message
- The generated copy reads as publishable Polish social content, and every figure in it is traceable to the source article

**Implementation Note**: This is the final phase — after manual verification, the slice is ready for `/10x-impl-review`.

---

## Testing Strategy

### Unit Tests:

- The numeral extractor and normalizer, exhaustively — both locales' separators, currency on either side, percentages, magnitude words in three languages, ranges, and the negative cases (years, ids, "5 min") that must *not* be extracted.
- Text extraction against fixtures for each failure reason, with no network.
- The generation call's control flow against `fakeLlmTransport`.

### Integration Tests:

- The orchestrator against the real database with a fake LLM: happy path, gate failure after retry, fetch fallback, re-run idempotency, ceiling hit, missing selection.

### Manual Testing Steps:

1. Confirm a selection on digest `c92aa3c5` through the S-04 UI.
2. Run `npm run generate` and read all four posts against their Spanish sources.
3. Check every price and percentage in the Polish copy against the article.
4. Temporarily point one story at an Idealista URL and confirm it degrades to the lede fallback rather than failing the digest.
5. Re-run `npm run generate` on the same digest and confirm it regenerates rather than duplicating.

## Performance Considerations

Nothing here is performance-sensitive: 2–4 fetches and 2–4 LLM calls, run once a week behind a human gate. The fetch timeout exists to bound a hung request, not to hit a latency target. The one real budget is the F-03 ceiling, and at this volume the stage should land well under a dollar — worth checking on the first real run, since generation is the first stage to send whole article bodies as input.

## Migration Notes

Two schema changes, both additive: a new `generated_copy` table and a nullable `digest.generation_completed_at`. Nothing existing is altered, so rollback is a `drop table` plus a `drop column`. As with every migration on this project, apply the SQL by hand through the Supabase SQL Editor and then hand-edit `src/db/database.types.ts` — `db push` is not usable until the F-01 migration-repair debt is settled.

## References

- Roadmap slice: `context/foundation/roadmap.md` § S-05
- Upstream gate (produces this stage's input): `context/archive/2026-08-01-story-selection-gate/plan.md`
- Orchestrator convention to copy: `src/lib/ranking/rank.ts:1-12`
- LLM harness contract: `src/lib/llm/invoke.ts:33-56`
- Corrective-retry precedent: `src/lib/ranking/cluster.ts:108-118`
- No-User-Agent-spoofing policy: `src/lib/collection/sources.ts:163`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Generated-copy schema

#### Automated

- [x] 1.1 Lint passes: `npm run lint` — fc94d5c
- [x] 1.2 Type check and build pass: `npm run build` — fc94d5c
- [x] 1.3 No test regressions: `npm test` — fc94d5c

#### Manual

- [x] 1.4 The migration applies cleanly through the Supabase SQL Editor — fc94d5c
- [x] 1.5 `generated_copy` is readable with the service role and denied with the anon key — fc94d5c
- [x] 1.6 A duplicate `(digest_id, cluster_id)` insert is rejected — fc94d5c

### Phase 2: Numeric-integrity module (FR-014)

#### Automated

- [x] 2.1 Lint passes: `npm run lint` — 7dd0aed
- [x] 2.2 Type check and build pass: `npm run build` — 7dd0aed
- [x] 2.3 Numeral suite passes: `npm test` — 7dd0aed

#### Manual

- [x] 2.4 `extractFigures` on a real Spanish article yields the story's key numbers and no page furniture — 7dd0aed

### Phase 3: Article text extraction

#### Automated

- [x] 3.1 Lint passes: `npm run lint`
- [x] 3.2 Type check and build pass with the new dependencies: `npm run build`
- [x] 3.3 Extraction suite passes: `npm test`

#### Manual

- [x] 3.4 A real article URL extracts body text without nav, cookie banner, or related links
- [x] 3.5 An Idealista URL degrades to a typed failure rather than hanging or throwing
- [x] 3.6 Figures found in real extracted text contain no page-furniture numerals

### Phase 4: Copy generation

#### Automated

- [ ] 4.1 Lint passes: `npm run lint`
- [ ] 4.2 Type check and build pass: `npm run build`
- [ ] 4.3 Generation suite passes: `npm test`

#### Manual

- [ ] 4.4 One real call produces Polish that reads as native social copy, not translated Spanish
- [ ] 4.5 The pulled-out statistics correspond to figures actually in the source

### Phase 5: Generation orchestrator

#### Automated

- [ ] 5.1 Lint passes: `npm run lint`
- [ ] 5.2 Type check and build pass: `npm run build`
- [ ] 5.3 Orchestrator suite passes: `npm test`

#### Manual

- [ ] 5.4 A digest whose sources all fetch cleanly produces rows with `source_text_origin = 'article'`

### Phase 6: `npm run generate` entrypoint

#### Automated

- [ ] 6.1 Lint passes: `npm run lint`
- [ ] 6.2 Type check and build pass: `npm run build`
- [ ] 6.3 Full suite passes: `npm test`

#### Manual

- [ ] 6.4 `npm run generate` produces 2–4 posts and leaves the digest in `ready_for_approval`
- [ ] 6.5 `npm run generate` on a digest not in `generating` exits 2 with a clear message
- [ ] 6.6 The copy reads as publishable Polish, and every figure is traceable to the source
