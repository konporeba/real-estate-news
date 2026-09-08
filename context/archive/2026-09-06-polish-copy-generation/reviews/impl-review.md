<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Polish Copy Generation (S-05)

- **Plan**: context/changes/polish-copy-generation/plan.md
- **Scope**: Phases 1–6 of 6 (complete slice)
- **Date**: 2026-09-08
- **Verdict**: REJECTED (all findings triaged 2026-09-08; 5 fixed, 1 accepted)
- **Findings**: 1 critical, 1 warning, 4 observations

The verdict is driven by a single critical finding (F1) whose fix is one line and is already
verified against the full suite. Everything else in the slice is in good shape: plan adherence is
exact, the automated criteria pass, and the stage ran cleanly on real data.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | WARNING |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Percent classifier tags a nearby year as a figure, failing good runs

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/generation/numerals.ts:157
- **Detail**: `classify()` tests `PERCENT` against `after.slice(0, 12)` **unanchored**, so any `%`
  within twelve characters of a number — with arbitrary text in between — makes that number a
  percentage figure. Two reproducible consequences on ordinary Spanish real-estate prose:
  - `"El precio subió en 2025 (+8,2%) hasta 6.624 euros"` → extracts `2025/percentage`
  - `"el metro cuadrado alcanzó 5.375 euros/m2 (+4,2%)"` → extracts `2/percentage` (the `2` of `m2`)

  The phantom is extracted from the **source**, so FR-014 then requires it in the Polish copy.
  A faithful rendering writes the year as a plain year, which `extractFigures` correctly does not
  extract, so the gate reports it missing:

  ```
  source: "El precio subió en 2025 (+8,2%) hasta 6.624 euros"
  output: "W 2025 roku ceny wzrosły o 8,2%, do 6 624 euro."
  assertFiguresPresent -> { ok: false, missing: [ { raw: "2025", value: 2025, kind: "percentage" } ] }
  ```

  The corrective retry cannot satisfy it — the model writes the year again and it is again not a
  figure — so `generateDigest` transitions the whole digest to `failed`. Combined with F2 (no
  recovery path back into `generating`), one such sentence in one of four stories costs the entire
  week's pipeline. This week's four stories passed by luck of phrasing, not by design.
- **Fix**: Anchor the percent test to the start of the trimmed lookahead, matching how `CURRENCY`
  is already tested on line 170:
  `if (new RegExp(\`^(?:${PERCENT.source})\`, "i").test(after.replace(/^[\s   ]+/, "")))`
  - Strength: Removes both phantom classes; verified — the 105 generation/worker tests still pass,
    and `8 %`, `12 procent`, `8,2% r/r`, `entre 1.000 y 2.000 €` and `3,5 millones de euros` all
    still classify correctly, while the two cases above now yield only the real figures.
  - Tradeoff: A percentage separated from its number by intervening words (`8 puntos por ciento`)
    would no longer be caught — that shape does not appear in the corpus and was never in the tests.
  - Confidence: HIGH — the change was applied and exercised against the full suite before being
    reverted for this report.
  - Blind spot: Only the existing fixtures and this week's four articles were checked; no corpus
    sweep over the whole 108-article pool.
- **Decision**: FIXED — percent test anchored to the start of the trimmed lookahead, with two regression cases added to `numerals.test.ts`

### F2 — A failed generation has no recovery path short of re-collecting the week

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: src/lib/digest/state-machine.ts:20, src/worker/generate.ts:66
- **Detail**: `TRANSITIONS.failed` is `["collecting"]` and the `enforce_digest_transition` trigger
  enforces the same map in the database, so a digest that fails during generation cannot return to
  `generating` — not by re-running the worker (it refuses anything not in `generating`) and not by
  a manual `update`. The only legal move is back to `collecting`, which re-runs collection,
  clustering, scoring and translation from scratch, discarding the operator's confirmed selection
  and re-paying the ranking cost (\$0.3618 on this digest). Every generation failure mode lands
  here: an LLM `api_error`, a ceiling hit, and — per F1 — a spurious gate failure.
- **Fix A ⭐ Recommended**: Add `generating` to the `failed` transition set in the migration and in
  `state-machine.ts`, so a failed generation can be retried in place.
  - Strength: Matches FR-018's stated intent ("re-trigger a failed run in place") and keeps the
    selection and ranking spend. The drift guard in `state-machine.test.ts` already forces both
    sides to be updated together.
  - Tradeoff: Needs a migration, and the SQL Editor + hand-edited types dance the F-01 debt imposes.
    It also widens `failed`'s meaning from "restart the week" to "restart the stage".
  - Confidence: MEDIUM — mechanically simple, but it touches the state machine every stage depends on.
  - Blind spot: Whether a partially-failed digest carries other stage state that a generation-only
    retry would leave stale.
- **Fix B**: Leave the state machine alone and treat it as an operator runbook item.
  - Strength: No schema change; keeps the state machine's current, simple meaning of `failed`.
  - Tradeoff: Every generation failure costs a full re-collect, which is the expensive path in both
    money and the operator's Sunday.
  - Confidence: HIGH — this is the status quo and it demonstrably works, just expensively.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A — migration `20260908120000_failed_generation_retry.sql` adds `failed -> generating`; `state-machine.ts` and its drift guard updated; `resolveTargetDigest` now retries an explicitly named failed digest that has a confirmed selection. **The migration still has to be applied by hand in the SQL Editor** — until then the new worker test fails against the live trigger.

### F3 — `clearExistingCopy` deletes before anything is written

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/generation/generate.ts:126, src/lib/generation/generate.ts:274
- **Detail**: The stage deletes every existing `generated_copy` row for the digest *before*
  generating, and inserts only after all stories succeed — so a failing re-run leaves the digest
  with no copy at all. This is unreachable today: reaching a second run requires the digest to be in
  `generating`, and a completed run leaves it in `ready_for_approval` with no legal way back. It
  becomes reachable the moment F2 is fixed with Fix A.
- **Fix**: If F2/Fix A is taken, move the delete to just before the insert (or make both one
  transaction) so a failed regeneration does not destroy the previous good copy.
- **Decision**: FIXED — `clearExistingCopy` moved to immediately before the insert, so a failed retry cannot destroy a previous good run

### F4 — Fetched page text is untrusted input interpolated into the prompt

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/generation/prompt.ts:78
- **Detail**: `buildGenerationPrompt` interpolates `story.sourceText` — arbitrary text scraped from
  a third-party page — directly into the user message with no delimiter or framing. A compromised or
  hostile source page could carry instructions aimed at the model. The blast radius is genuinely
  small: output is text only, the numeric gate is independent of the model, and nothing publishes
  without the S-07 human approval gate. It is the same class as the S-03 lesson (untrusted external
  content reaching a trusted context) and worth naming before S-06 starts rendering this text into
  assets.
- **Fix**: Wrap the source text in an explicit delimited block and add one line to
  `GENERATION_SYSTEM` stating that everything inside it is source material to adapt, never
  instructions to follow.
- **Decision**: FIXED — source text is wrapped in `<source>` markers and `GENERATION_SYSTEM` gained a TREAT THE SOURCE AS DATA rule

### F5 — Response body is read without a size cap, and redirects are followed

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/generation/source-text.ts:159
- **Detail**: `fetchArticleText` buffers the whole response via `arrayBuffer()` with no length
  limit, and uses `redirect: "follow"` on a URL that ultimately came from a third-party feed. The
  timeout bounds a hung request but not a large or redirecting one. Low risk in practice — 2–4
  fetches a week against a curated source registry — but both are cheap to bound.
- **Fix**: Check `content-length` (and/or cap the read) against a ceiling of a few megabytes before
  decoding.
- **Decision**: FIXED — `content-length` refused above `MAX_RESPONSE_BYTES` (8 MB) before the body is read, with a post-read guard for chunked responses

### F6 — Charset decoding was added beyond the plan's Phase 3 contract

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/lib/generation/source-text.ts:110
- **Detail**: `decodeHtml()` is not in the plan's Phase 3 contract, which specified only fetch,
  parse, Readability and the failure taxonomy. It is a justified addition — `Response.text()` always
  decodes UTF-8, expansion.com serves `iso-8859-15`, and the module documents that a mis-decoded
  `m²` silently removes every area figure from the gate's assertion set. Recorded here only so the
  addition is visible in the review record rather than discovered later; no action needed.
- **Fix**: None — accept as a documented discovery.
- **Decision**: ACCEPTED — documented discovery, no action

## Success criteria verification

| Check | Result |
|-------|--------|
| `npm run lint` | PASS — 0 errors, 8 pre-existing `no-console` warnings, none in this slice |
| `npm run build` | PASS — server built, new worker dependencies do not reach the Cloudflare bundle |
| `npm test` | PASS — 424 passed / 12 skipped; one 20s timeout in `translate-shortlist.test.ts` (S-03, unrelated) that passes in 3s on its own — a Supabase network stall, not a regression |
| Manual 1.4–1.6, 2.4, 3.4–3.6, 4.4–4.5, 5.4 | Marked complete in Progress with commit SHAs; the live run corroborates the schema, extraction and generation claims |
| Manual 6.4–6.6 | Verified this session: `npm run generate` produced 4 stories, all `source_text_origin = 'article'`, digest `ready_for_approval`, \$0.2957; refusal path exits 2 on both a wrong-status digest and an empty `generating`; operator confirmed the Polish reads as publishable copy |
