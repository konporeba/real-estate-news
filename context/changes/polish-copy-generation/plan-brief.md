# Polish Copy Generation (S-05) — Plan Brief

> Full plan: `context/changes/polish-copy-generation/plan.md`

## What & Why

The operator has passed the S-04 selection gate — 2–4 stories picked, a format and platforms chosen — and the digest now sits in `generating` with nothing to advance it. This slice adapts each selected Spanish story into publishable Polish social copy, and deterministically proves that every significant figure in the source survived the adaptation before anything reaches the approval gate.

## Starting Point

The pipeline runs end to end up to the first human gate: collection, geography ranking, translation, and the selection UI all ship. `generating → ready_for_approval` exists in the state machine, but no worker consumes it, and the `generated_asset` table F-01 deferred was never built. Digest `c92aa3c5` will park in `generating` the moment a selection is confirmed.

## Desired End State

`npm run generate` turns a confirmed digest into 2–4 Polish posts — title, caption summary, body copy sized to the chosen format, and 3–5 pulled-out statistics — each stored in its own row and each verified figure-by-figure against its source article, leaving the digest in `ready_for_approval`.

## Key Decisions Made

| Decision | Choice | Why |
| --- | --- | --- |
| Source material | Fetch the full article at generation time | The stored lede is a median of **184 characters**; "body copy for slides" and "key statistics" are unreachable from two sentences without invention. Only 2–4 fetches a week. |
| Fetch failure | Fall back to title + lede, record it on the row | Idealista is enabled and known to block; one refused source must not kill the week. `source_text_origin` tells the operator why a post reads short. |
| Numeric gate | Normalize both sides, then assert every source figure is present | Catches real drift (1.234 → 1.243) without failing on legitimate es→pl reformatting (`1.234,56 €` vs `1 234,56 zł`). |
| Which numerals | Significant figures only — currency, percentages, unit/magnitude numbers | The classes FR-014 names. Policing every digit would fail nearly every run on bylines and article ids, and a gate that cries wolf gets switched off. |
| Gate failure | Fail the whole digest to `failed` | FR-014 says "failure fails the run", and it matches the collect/rank convention. Dropping a story would silently override the operator's own pick. |
| Text extraction | `@mozilla/readability` + `linkedom` | Boilerplate numerals poison the gate — a leaked "© 2024" becomes a figure the copy must contain. Extraction quality is a correctness concern, not a nicety. |
| Data model | One row per story, typed columns | S-07 renders it with a plain select and S-06 fills template slots by column name; follows the `selection` precedent of real columns over blobs. |
| Call shape | One `invoke()` call per story | A gate-failing story retries in isolation. Batching exists in scoring to cut 250 calls to 21 — a problem that does not exist at n=4. |
| Model | Sonnet 5, as a named constant | Operator chose to ship on the pipeline default and compare Opus against real output later; the constant makes that a one-line change. |
| Trigger | `npm run generate`, manual | Generation follows a human gate, so it cannot join the Sunday chain. S-01 and S-02 both shipped manual-first and were automated later. |
| Re-run | Delete and regenerate every story | Exactly the precedent `clearExistingClusters` sets; at 2–4 stories, consistency is worth cents. |
| Voice | A version-controlled prompt constant | Same shape as `GEOGRAPHY_RUBRIC_SYSTEM` — reviewable in a diff, tunable against real output. |
| Testing | Unit-test the gate hard, spot-check the copy | The gate has a right answer and fails silently; "good social copy" has no ground truth to build an eval against. |

## Scope

**In scope:** `generated_copy` schema + `generation_completed_at` checkpoint; the numeric-integrity module; article fetch/extraction with a lede fallback; the voice prompt and per-story generation call; the stage orchestrator and its digest transition; the `npm run generate` entrypoint.

**Out of scope:** visual assets (S-06); the approval UI and its email (S-07); per-platform copy variants; a copy-quality eval harness; operator-editable voice; scheduler integration; few-shot from past posts; storing article bodies back onto `article`; the F-01 migration-repair debt.

## Architecture / Approach

```
selection + picked selection_item
        │
        ▼
  fetchArticleText ──(blocked/unparseable)──► lede fallback, flagged on the row
        │
        ▼
  generateCopy  ──one invoke() per story, zod schema
        │
        ▼
  assertFiguresPresent ──(fail)──► one corrective retry ──(fail)──► digest → failed
        │
        ▼
  persist generated_copy → markStageComplete → ready_for_approval
```

Worker-side throughout (`src/lib/generation/`, `src/worker/generate.ts`), following `rank.ts`'s convention: infrastructure errors return raw; genuine failures transition the digest to `failed` and still return `ok: true`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema | `generated_copy` + checkpoint + hand-written types | Shape is consumed by S-06 and S-07 — wrong now means rework twice |
| 2. Numeric gate | Pure extract/normalize/assert module | Cross-locale normalization is subtle; a false failure blocks good runs |
| 3. Extraction | Fetch + Readability with typed failures | Real-world markup is hostile; leaked boilerplate poisons the gate |
| 4. Generation | Voice prompt + per-story structured call | Thinking is on, so an undersized `maxTokens` truncates silently |
| 5. Orchestrator | Compose, gate, persist, transition | Failure branches are where the last two reviews found real bugs |
| 6. Entrypoint | `npm run generate` | Low — mirrors `npm run rank` |

**Prerequisites:** S-04 shipped (done); F-03 harness (done); a digest with a confirmed selection — `c92aa3c5` once the gate is clicked through.
**Estimated effort:** ~3–4 sessions across 6 phases; phases 2 and 3 are the substantive ones.

## Open Risks & Assumptions

- **Carousel length is a guess.** PRD OQ#3 is unresolved and owned by the operator; the plan fixes 5 slides as a named constant so S-06 has something to build against and changing it is one line.
- **Extraction quality is unproven against these specific sources.** Readability is battle-tested generally, but Expansión, El País, Idealista and Fotocasa each have their own markup; Phase 3's manual checks exist to find that out before generation depends on it.
- **The numeric gate may still produce false failures** on figure classes the normalizer does not anticipate (approximations, ranges written unusually). The corrective retry absorbs one; a systematic pattern would need the extractor tuned.
- **This is the first stage to send whole article bodies as LLM input**, so its real cost is unmeasured — worth checking against the ceiling on the first live run.
- **Copy quality has no regression gate.** A prompt change can degrade output with nothing to catch it but the operator reading the result.

## Success Criteria (Summary)

- The operator runs one command and gets 2–4 Polish posts that read as native social copy, not translated Spanish.
- Every price and percentage in that copy is traceable to its source article — and if one is not, the run fails loudly instead of publishing a wrong figure.
- The digest lands in `ready_for_approval`, ready for S-07 to build the approval gate on.
