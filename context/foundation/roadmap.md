---
project: "Real Estate News"
version: 1
status: draft
created: 2026-07-22
updated: 2026-07-31
prd_version: 1
main_goal: quality
top_blocker: none
---

# Roadmap: Real Estate News

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

A single real-estate professional serving Polish investors in Spain publishes nothing on social media because the weekly manual workflow — read Spanish sources, judge relevance, translate, design, publish — is too expensive in time. This product automates the gathering, ranking, translation, and design so the operator makes only two judgment calls (which stories to publish, and final approval), turning zero posts a week into consistent weekly posts. The differentiator is editorial judgment, not scraping: a geography-first rule that ranks Spanish real-estate stories by closeness to a Barcelona/Catalonia audience and whether they touch money or regulation.

## North star

**S-03: operator opens the dashboard and sees the top-15 ranked, translated Polish shortlist (Spanish originals alongside).** — This is the validation milestone under a `quality` goal: it exercises the editorial rubric end-to-end on real sources, which is both the product's differentiator and the riskiest place for the system to misjudge. If the shortlist is good, the rest of the flow (select → generate → approve → publish) is comparatively known work.

> "North star" here means the smallest end-to-end slice whose successful delivery would prove the core product hypothesis — placed as early as its Prerequisites allow because everything downstream only matters if this works. S-03 sits at the head of the collect→rank→display chain (S-01 → S-02 → S-03); those two prerequisites are the enabling path, not competing priorities.

## At a glance

| ID   | Change ID                    | Outcome (user can …)                                                 | Prerequisites    | PRD refs                         | Status   |
| ---- | ---------------------------- | -------------------------------------------------------------------- | ---------------- | -------------------------------- | -------- |
| F-01 | durable-digest-run-state     | (foundation) durable digest state machine + core schema in place     | —                | NFR-durability, §Data, §State    | done     |
| F-02 | operator-pin-access-gate     | (foundation) PIN gate + lockout replaces email/password auth         | —                | US-22, NFR-access, §Access       | done     |
| F-03 | llm-cost-ceiling-harness     | (foundation) budgeted, retry-safe LLM invocation wrapper             | —                | FR-016, FR-017, NFR-cost         | done     |
| F-04 | outbound-email-notifications | (foundation) system can email the operator                           | —                | FR-010, FR-019, FR-021           | done     |
| F-05 | reliable-scheduler-backbone  | (foundation) DST-correct persistent scheduler primitive              | F-01             | FR-027, FR-022, NFR-time         | done     |
| S-01 | weekly-source-collection     | trigger/re-trigger a week's article collection                       | F-01             | FR-001,002,003,018; US-01→04     | done     |
| S-02 | geography-ranking-rubric     | (system) cluster + geography-rank the pool, gated by an eval harness | S-01, F-03       | FR-004→008,026; US-06,07,08,25   | done     |
| S-03 | translated-shortlist-view    | view the ranked Polish shortlist on the dashboard ★                  | S-02, F-02       | FR-008,009,009a,011; US-05,07,22 | done     |
| S-04 | story-selection-gate         | select 2–4 stories, format, and platforms                            | S-03, F-04       | FR-010,012; US-09,10             | proposed |
| S-05 | polish-copy-generation       | get Polish social copy with a numeric-integrity gate                 | S-04, F-03       | FR-013,014,016,017; US-11,12,15  | proposed |
| S-06 | brand-visual-assets          | get per-platform visuals from brand templates                        | S-05             | FR-015; US-13,14                 | proposed |
| S-07 | content-approval-gate        | approve/reject before publish; get a Monday reminder                 | S-05, S-06, F-04 | FR-019,020,021; US-16,17         | proposed |
| S-08 | scheduled-publishing         | publish approved content on schedule, per platform                   | S-07, F-05       | FR-022,023; US-18,19,20          | proposed |
| S-09 | archive-and-learning-loop    | browse the archive; picks/passes refine the rubric                   | S-08, S-02       | FR-024,025; US-10,21             | proposed |
| S-10 | ops-heartbeat-and-catchup    | learn when nothing ran; missed windows are caught up                 | F-05             | FR-027,028; US-23,24             | proposed |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                        | Chain                                                        | Note                                                                               |
| ------ | ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| A      | Editorial brain (north star) | `F-01` → `S-01` → `S-02` → `S-03`                            | The core bet; consumes `F-03` at `S-02`. Reaches the north star `S-03`.            |
| B      | Access gate                  | `F-02`                                                       | Joins Stream A at `S-03` (the first auth-gated dashboard view).                    |
| C      | Publish loop                 | `F-04` → `S-04` → `S-05` → `S-06` → `S-07` → `S-08` → `S-09` | Selection→generation→publish→archive; consumes `F-03` at `S-05`, `F-05` at `S-08`. |
| D      | LLM safety harness           | `F-03`                                                       | Standalone foundation; unlocks `S-02` (Stream A) and `S-05` (Stream C).            |
| E      | Ops reliability              | `F-05` → `S-10`                                              | Independent track; `F-05` also enables automatic `S-01` and scheduled `S-08`.      |

## Baseline

What's already in place in the codebase as of `2026-07-22` (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — Astro 6 + React 19 + Tailwind 4; layouts/components/pages scaffolded (`src/`). Per `tech-stack.md`.
- **Backend / API:** partial — Astro server runtime + API-route pattern exists (`src/pages/api/auth/*`), but only auth endpoints; no domain/pipeline routes.
- **Data:** present as of 2026-07-24 (F-01) — `digest`/`article`/`cluster` in `supabase/migrations/20260722173032_digest_core_schema.sql`, deny-by-default RLS, generated `Database` type in `src/db/database.types.ts`, and the run-state module in `src/lib/digest/`. Later slices add their own tables (`selection`, `generated_asset`, `publication`, `feedback_label`). Was: absent at 2026-07-22.
- **Auth:** partial — Supabase email/password fully scaffolded (`src/middleware.ts`, `src/pages/auth/*`, `src/pages/api/auth/*`), but the PRD requires a 6-digit PIN + lockout, not email/password — the scaffolded mechanism is wrong for this product.
- **Deploy / infra:** partial — scaffold ships `wrangler.jsonc` (Cloudflare) + a GitHub Actions `ci.yml`, but the real target is self-host on a Raspberry Pi (Cloudflare Tunnel, systemd timer) and CI choice is GitLab; none of that infra exists yet.
- **Observability:** absent — no logging / error tracking / metrics / heartbeat.

## Foundations

### F-01: Durable digest run-state & core schema

- **Outcome:** (foundation) the digest state machine (`collecting → ranking → ready_for_selection → generating → ready_for_approval → approved → published`, plus `skipped`/`failed`) is persisted with per-stage checkpoints, and the core `digest`/`article`/`cluster` tables exist — enough for a multi-day run to survive a machine restart.
- **Change ID:** durable-digest-run-state
- **PRD refs:** NFR "Durability of in-flight state", §Business Logic, §Data Model sketch, §Digest State Machine
- **Unlocks:** S-01 (collection writes articles), S-02 (clusters), S-03 (shortlist read); reduces the durability NFR risk that the three-day Sunday→Tuesday window loses state.
- **Prerequisites:** — (Supabase Postgres present per baseline)
- **Parallel with:** F-02, F-03, F-04
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Sequenced first because nothing in the pipeline can be built or verified without durable run-state. Scope kept minimal — later slices add their own tables (selection, generated_asset, publication, feedback_label); this is the state-machine contract + three core tables, not the whole data layer.
- **Status:** done (shipped 2026-07-24, commits `00280d7`…`0deb13f`)
- **Delivered:** `digest`/`article`/`cluster` schema with the `digest_status` enum, transition-guard + `updated_at` triggers, `one_active_digest_per_week` partial unique index, deny-by-default RLS; generated `Database` type wired into the SSR client plus a server-only service-role client; a typed run-state module (`src/lib/digest/run-state.ts`) exposing `createDigest`, `transitionDigest`, `markStageComplete`, `getActiveDigestForWeek`, `resumeDigest`; Vitest with a drift guard that fails when the TS transition map and the SQL trigger diverge.
- **Carried forward:** the migration was applied to the cloud project via the SQL Editor, so it is **not** recorded in `supabase_migrations.schema_migrations` — repair (`supabase link` + `migration repair --status applied 20260722173032`) is required before the next `db push`. A `check (window_end >= window_start)` constraint is deferred to that same migration. See `context/changes/durable-digest-run-state/reviews/impl-review.md` (F1, F8).

### F-02: Operator access gate (PIN + lockout, private path)

- **Outcome:** (foundation) the dashboard is gated by a 6-digit PIN with lockout-after-~5-attempts and rate limiting, reachable only over a private path (Cloudflare Tunnel) — replacing the scaffold's email/password auth, which is the wrong mechanism for this product.
- **Change ID:** operator-pin-access-gate
- **PRD refs:** US-22, §Access Control, NFR "Access resistance"
- **Unlocks:** S-03 (the first auth-gated dashboard view) and every later dashboard slice; reduces the access-resistance NFR risk that publishing controls are reachable by guessing.
- **Prerequisites:** —
- **Parallel with:** F-01, F-03, F-04
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Under a `quality` goal the access gate is not deferred behind user-facing slices. Must swap out the scaffolded email/password flow rather than layer on top of it; leaving both in place would be a second, weaker auth path. Minimal scope: the PIN gate + lockout + tunnel exposure, not a general identity system (there is only ever one operator).
- **Status:** done

### F-03: LLM cost-ceiling & resilient-invocation harness

- **Outcome:** (foundation) a shared wrapper around every model call that enforces a hard per-run cost ceiling and halts on reaching it, with staged malformed-output recovery and bounded backoff retries — so an unattended run can never bill quietly overnight.
- **Change ID:** llm-cost-ceiling-harness
- **PRD refs:** FR-016, FR-017, US-15, NFR "Bounded cost per run"
- **Unlocks:** S-02 (whole-pool scoring calls), S-05 (generation calls); reduces the bounded-cost NFR risk on every LLM stage.
- **Prerequisites:** —
- **Parallel with:** F-01, F-02, F-04
- **Blockers:** —
- **Unknowns:** ~~Which model SDK/provider exposes the budget primitive (`maxBudgetUsd` / `maxCost`)~~ — **Resolved 2026-07-24: none does.** The Anthropic API has no USD-denominated budget parameter. The ceiling must be computed application-side from `usage` token counts × a per-model price table, checked before each call and accumulated after. `output_config.task_budget` (beta) is a _token_ budget the model paces itself against — explicitly a suggestion, not a hard cap — so it cannot serve as the enforcement mechanism. This makes F-03 a larger slice than assumed: it owns the accounting, not just a wrapper. Detail in `context/changes/llm-cost-ceiling-harness/change.md`.
- **Scope note (2026-07-24):** FR-017's malformed-output recovery is largely obviated by structured outputs (`output_config.format` + `strict: true`), which constrain the shape rather than repairing it; staged recovery should be a narrow fallback. Transport retry/backoff already ships in the SDK (`maxRetries` default 2, covering 408/409/429/5xx). Two cost levers found during the same research and inherited by S-02: the **Message Batches API halves cost** on whole-pool scoring (asynchronous by nature), and **prompt caching** on the shared rubric prefix cuts repeat input to ~0.1× — subject to a model-dependent minimum cacheable prefix (4096 tokens on Opus 4.8, 2048 on Sonnet 5) below which it silently does not cache.
- **Risk:** The first LLM call (S-02 scoring, over the whole article pool) is exactly the unattended failure mode this guards, so the harness precedes it. Minimal scope: budget enforcement + retry/recovery contract, not a general model-orchestration layer — each slice still owns its own prompts.
- **Status:** done

### F-04: Outbound email notifications

- **Outcome:** (foundation) the system can send the operator email at defined pipeline moments — a minimal, reusable send capability, not a template/marketing system.
- **Change ID:** outbound-email-notifications
- **PRD refs:** FR-010, FR-019, FR-021
- **Unlocks:** S-04 (digest-ready email), S-07 (approval-ready email + Monday reminder); reduces the unattended-reliability NFR risk that the operator isn't told a gate is waiting.
- **Prerequisites:** —
- **Parallel with:** F-01, F-02, F-03
- **Blockers:** —
- **Unknowns:**
  - Whether a second channel (e.g. push/Telegram) is wanted specifically for the time-critical Monday reminder — Owner: operator. Block: no. (PRD Open Question #6.) Confirmed non-blocking: F-04 shipped email-only without resolving this.
- **Risk:** Small enabler, but genuinely cross-cutting (three notification points across two slices), so it lives here rather than being owned by whichever slice happens to send the first email.
- **Status:** done (shipped 2026-07-28, commits `25855e4`…`c8bac8d`)
- **Delivered:** a worker-side `src/lib/email/` module mirroring `src/lib/llm/`'s harness shape — `createEmailClient()` (Gmail SMTP transport, `null` on missing config) and `sendEmail()` (never throws, typed `EmailResult`), plus a reusable branded HTML email layout (`renderEmailHtml`/`renderEmailText`) restyled mid-implementation to match the client's other app ("Real Estate AI Agent") for a shared visual identity across both products. Also delivered `renderArticleCards()` — a generic, color-coded-by-relevance-tier article-card rendering primitive, added interactively against rendered previews once the operator asked for per-article visibility in the digest email. 30 unit tests against a fake transport; verified once against real Gmail via an opt-in live smoke test (`EMAIL_LIVE_SMOKE=1`). No pipeline stage calls it yet — S-04 and S-07 are the first real callers.
- **Carried forward:** the impl-review (`context/changes/outbound-email-notifications/reviews/impl-review.md`, verdict APPROVED, 0 critical/warnings, 4 observations) found two low-impact gaps, both fixed before commit: `escapeHtml()` is now exported with `EmailContent.bodyHtml` documented as raw/trusted HTML (so a future hand-built caller has a sanctioned escaping utility), and an http(s)-only URL-scheme allowlist was added on `cta`/article links (blocks `javascript:` URIs from rendering as clickable). Neither is a blocker for S-04/S-07.

### F-05: Reliable scheduler backbone

- **Outcome:** (foundation) a persistent scheduling primitive that fires jobs at a named-zone (`Europe/Warsaw`) wall-clock time correctly across the DST transition and replays a window missed while the machine was off — the timing mechanism the automatic Sunday collection and Tuesday publish plug into.
- **Change ID:** reliable-scheduler-backbone
- **PRD refs:** FR-027, FR-022 (timing), NFR "Correct-time publishing", §Forward-tech-stack (systemd `Persistent=true`)
- **Unlocks:** automatic firing of S-01 (Sunday collection) and S-08 (Tuesday publish), plus S-10 (catch-up + heartbeat); reduces the correct-time and unattended-reliability NFR risks.
- **Prerequisites:** F-01 (needs run-state to schedule against)
- **Parallel with:** S-01, S-02, S-03, S-04, S-05, S-06, S-07 (independent scheduler track)
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Deliberately sequenced after F-01 and buildable in parallel with the pipeline: the pipeline is verified via manual triggers first (S-01/FR-018), then this automates it. DST correctness via a named zone (never a fixed offset) is the load-bearing detail. Minimal scope: the timer + catch-up primitive, not the heartbeat/alerting behavior (that's S-10).
- **Status:** done

## Slices

### S-01: Weekly source collection

- **Outcome:** operator can trigger (or the scheduler can auto-run) a week's collection, pulling articles from a configured source list — resilient to a blocked source and to a thin news week.
- **Change ID:** weekly-source-collection
- **PRD refs:** FR-001, FR-002, FR-003, FR-018, US-01, US-02, US-03, US-04
- **Prerequisites:** F-01
- **Parallel with:** F-02, F-03, F-04, F-05
- **Blockers:** —
- **Unknowns:** — (both resolved 2026-07-24; see Open Roadmap Questions #1 and #7)
- **Risk:** Per-source tiering (RSS → API → rendered fetch) is the fragile surface — Idealista in particular blocks scrapers. Built with a manual re-trigger first so the whole downstream pipeline is verifiable before F-05 automates the Sunday run.
- **Status:** done

### S-02: Geography-ranking rubric (with eval harness)

- **Outcome:** (system) the week's articles are semantically clustered (coverage count as a ranking boost, not redundancy) and each cluster is scored by the geography-first rubric from title + lede — with an eval harness that gates any rubric change against known-correct examples.
- **Change ID:** geography-ranking-rubric
- **PRD refs:** FR-004, FR-005, FR-006, FR-007, FR-008, FR-026, US-06, US-07, US-08, US-25
- **Prerequisites:** S-01, F-03
- **Parallel with:** F-02, F-04, F-05
- **Blockers:** —
- **Unknowns:** —
- **Risk:** This is the product. The rubric must separate where a story was _published_ from where its _effects_ land (a national announcement made in Madrid is national, not "Madrid news") — the PRD flags this as the most likely misjudgment. Shipping the rubric together with its eval harness is the quality-first bet: the regression gate must exist before the rubric is tuned.
- **Status:** done (shipped 2026-07-27, commits `2ae85c4`…`6ace8e6`)
- **Delivered:** the `ranking` stage end to end — score schema + eval harness gating the rubric (Phase 1), the zero-shot geography rubric and batched scoring function (Phase 2), LLM clustering with partition validation (Phase 3), the ranking orchestrator composing cluster→score→order→persist→transition (Phase 4), and the `npm run rank` worker entrypoint (Phase 5). Verified against a real ~368-article digest: 250 clusters, top-15 correctly geography-ordered (Catalonia tier above national).
- **Carried forward:** real-pool verification surfaced three fixes the mocked test suite couldn't — see `src/lib/ranking/cluster.ts` and `src/lib/llm/invoke.ts`. (1) Clustering echoes article ids into the model's response; a real UUID costs far more output tokens than a short local index, so ids are now localized to array-position strings for the prompt/response and mapped back after parsing. (2) Sonnet 5 runs adaptive thinking by default when `thinking` is omitted from a request — a silent behavior change from earlier models — and `invoke()`'s `maxTokens` caps thinking plus output combined, so hidden reasoning tokens were silently consuming the budget meant for the JSON output. `invoke()` now accepts a `thinking` flag; clustering disables it. Any future `invoke()` caller on Sonnet 5 with a tight `maxTokens` should consider the same. (3) At real pool size the model occasionally mis-partitions (drops or duplicates an id) on the single-pass whole-pool grouping; `clusterArticles` now does one corrective retry, mirroring `invoke()`'s own schema-validation retry pattern. The impl-review (`reviews/impl-review.md`) found a fourth issue: the persist path wrote one row at a time in a loop (~500 sequential round trips on the real pool) — fixed with two new Postgres RPC functions (`assign_articles_to_clusters`, `persist_cluster_rankings`, migration `20260727150000_bulk_ranking_writes.sql`) since PostgREST's `.upsert()` can't express a partial-row bulk update, the same "make it a function" precedent as `increment_digest_cost`.

### S-03: Translated shortlist view ★ (north star)

- **Outcome:** operator opens the dashboard and sees the top-15 shortlist — Polish title + summary with the original Spanish title/lede alongside (each language-flagged), multi-source stories shown as a single entry annotated with coverage count.
- **Change ID:** translated-shortlist-view
- **PRD refs:** FR-008, FR-009, FR-009a, FR-011, US-05, US-07, US-22
- **Prerequisites:** S-02, F-02
- **Parallel with:** F-04, F-05
- **Blockers:** —
- **Unknowns:** —
- **Scope note (2026-07-24):** the source list resolved under OQ#1 ships two Catalan-language feeds, so the translation stage is `{es,ca}→pl`, not the `es→pl` FR-013 declares. Each article carries its source `language`; the "original alongside" requirement (FR-009a) means a Catalan original is displayed as Catalan.
- **Risk:** The validation milestone — first point where the editorial brain is visible to the operator. Batch translation (FR-009) is idempotent and runs once here via the F-03 harness; retaining both languages (FR-009a) is a hard requirement, not a nicety, so an odd translation can be checked against the source.
- **Status:** done (shipped 2026-07-30, commits `1487ce7`…`58a4c56`; impl-review fixes `1e920ef`, translation model swap `7bb3b97`)
- **Delivered:** the translation stage in the ranking worker (`translateShortlist`, Spanish/Catalan → Polish on the shortlisted clusters' representative articles), the digest list page (`src/pages/dashboard.astro`) and shortlist detail page (`src/pages/dashboard/[id].astro`) behind the F-02 PIN gate, each shortlist item showing Polish title/summary with the original alongside (language-flagged) and a coverage count for multi-source stories.
- **Carried forward:** the impl-review (`context/changes/translated-shortlist-view/reviews/impl-review.md`, initial verdict REJECTED on one critical) found `source_url` rendered as a clickable link with no scheme check (F1, fixed — `isSafeUrl()` guard) and Supabase query errors silently rendering as an empty-state rather than a distinct failure (F2, fixed). F3 remains an **open verification gap, not a defect**: the literal "operator opens a `ready_for_selection` digest and sees real Polish text" path has still not been eyeballed live — the only real digest in the database predates this feature, and a live re-run to close the gap was deferred (cost/budget considerations on that specific digest, plus a collection-window quirk when attempting a fresh one). Translation was also switched from Sonnet 5 to Haiku 4.5 post-review as a cost optimization (bounded, mechanical task with an existing completeness check) — validated safe by `RANKING_EVAL` showing Haiku is *not* safe for the scoring stage (misjudges tier on held-out examples), so clustering/scoring stay on Sonnet 5.

### S-04: Story selection gate (human gate 1)

- **Outcome:** operator can select 2–4 stories, a format (single post or carousel), and target platforms; the digest moves to `generating`, and both the picks and the passes are stored as labeled examples.
- **Change ID:** story-selection-gate
- **PRD refs:** FR-010, FR-012, US-09, US-10
- **Prerequisites:** S-03, F-04
- **Parallel with:** F-05, S-10
- **Blockers:** —
- **Unknowns:**
  - Selection granularity: when picking a multi-source cluster, does the operator pick the cluster (system chooses source material) or a specific article within it — Owner: operator. Block: no. (PRD Open Question #4.)
- **Risk:** Capturing passes as well as picks (US-10) is what makes the later learning loop (S-09) possible, so the storage shape is decided here even though its consumer comes later.
- **Status:** proposed

### S-05: Polish copy generation (with numeric-integrity gate)

- **Outcome:** operator's selected stories get full Spanish→Polish social adaptation — compelling title, caption-ready summary, body copy for the chosen format, and pulled-out key statistics — with every source numeral deterministically asserted present in the output or the run fails.
- **Change ID:** polish-copy-generation
- **PRD refs:** FR-013, FR-014, FR-016, FR-017, US-11, US-12, US-15
- **Prerequisites:** S-04, F-03
- **Parallel with:** F-05, S-10
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Numeric integrity (FR-014) is a deterministic check, not a prompt promise — a mismatch blocks the run. Only the 2–4 selected stories get this expensive treatment, and the F-03 ceiling bounds the retry loop.
- **Status:** proposed

### S-06: Brand visual assets

- **Outcome:** operator gets per-platform visual output filled from brand templates (one template per platform format), with design changes owned by the operator in the visual editor and requiring no code change.
- **Change ID:** brand-visual-assets
- **PRD refs:** FR-015, US-13, US-14
- **Prerequisites:** S-05
- **Parallel with:** F-05, S-10
- **Blockers:** —
- **Unknowns:**
  - Visual-template (Canva) API access sits behind a paid tier and may require an access application with external lead time — Owner: operator. Block: no, but start the request now. (PRD Open Question #2.)
  - Carousel length: fixed, or driven by story count — Owner: operator. Block: no. (PRD Open Question #3.)
- **Risk:** The Canva access dependency is the roadmap's one real external lead-time item; it doesn't block earlier slices (the north-star path never touches it), but the request should be filed early so it's approved by the time this slice is planned.
- **Status:** proposed

### S-07: Content approval gate (human gate 2)

- **Outcome:** operator is emailed that content is ready, reviews the complete generated post, and approves or rejects it before anything publishes — with a Monday reminder email if any step is still unvalidated.
- **Change ID:** content-approval-gate
- **PRD refs:** FR-019, FR-020, FR-021, US-16, US-17
- **Prerequisites:** S-05, S-06, F-04
- **Parallel with:** F-05, S-10
- **Blockers:** —
- **Unknowns:** —
- **Risk:** The digest waits in `ready_for_approval` indefinitely — nothing publishes without an explicit approve, in every path. Reviews the full post (copy + visuals), hence the S-06 prerequisite.
- **Status:** proposed

### S-08: Scheduled publishing

- **Outcome:** approved content publishes at Tuesday 17:00 `Europe/Warsaw` to each selected platform, with per-platform success/failure recorded independently; a missed approval deadline skips the auto-publish and leaves the digest manually publishable, never publishing unapproved content.
- **Change ID:** scheduled-publishing
- **PRD refs:** FR-022, FR-023, US-18, US-19, US-20
- **Prerequisites:** S-07, F-05
- **Parallel with:** S-10
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Reuses the already-validated social publishing integration from the prior project (a Non-Goal to rebuild). One platform failing must not lose the others (US-20), so publishing is per-platform independent. The timed fire and DST-correctness come from F-05.
- **Status:** proposed

### S-09: Archive & learning loop

- **Outcome:** operator can browse a full-fidelity archive of every past digest (shortlist shown, picks and passes, generated copy, visuals, targets, per-platform results), and each week's picks-vs-passes feed back into the ranking rubric as few-shot material.
- **Change ID:** archive-and-learning-loop
- **PRD refs:** FR-024, FR-025, US-10, US-21
- **Prerequisites:** S-08, S-02
- **Parallel with:** S-10
- **Blockers:** —
- **Unknowns:**
  - Retention policy for full-fidelity archive material given local disk on the Pi — Owner: operator. Block: no. (PRD Open Question #5.)
- **Risk:** Feeding picks/passes back into the rubric changes rubric behavior, so this depends on S-02's eval harness to catch drift — the learning loop is only safe because the regression gate exists.
- **Status:** proposed

### S-10: Ops heartbeat & catch-up

- **Outcome:** operator learns when nothing ran (an external monitor alerts on missing heartbeat) rather than mistaking silence for "no news," and a run missed while the machine was off is executed on next start.
- **Change ID:** ops-heartbeat-and-catchup
- **PRD refs:** FR-027, FR-028, US-23, US-24
- **Prerequisites:** F-05
- **Parallel with:** S-04, S-05, S-06, S-07, S-08, S-09
- **Blockers:** —
- **Unknowns:** —
- **Risk:** A home server's silence is ambiguous; the dead-man's-switch closes that gap. Builds on F-05's persistent-timer primitive to turn "missed window" into "run executed on next boot" plus an external alert.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID                    | Suggested issue title                               | Ready for `/10x-plan` | Notes                                                                           |
| ---------- | ---------------------------- | --------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| F-01       | durable-digest-run-state     | Durable digest run-state & core schema              | shipped               | Shipped 2026-07-24; see impl-review F1                                          |
| F-02       | operator-pin-access-gate     | PIN access gate replacing scaffold auth             | yes                   | Independent; enables the dashboard                                              |
| F-03       | llm-cost-ceiling-harness     | Budgeted, retry-safe LLM invocation harness         | shipped               | Shipped & reviewed 2026-07-25; unblocks S-02                                    |
| F-04       | outbound-email-notifications | Outbound email notification capability              | shipped               | Shipped 2026-07-28; reviewed (impl-review APPROVED, 2 low-impact fixes applied) |
| F-05       | reliable-scheduler-backbone  | DST-correct persistent scheduler primitive          | yes                   | F-01 shipped; unblocked                                                         |
| S-01       | weekly-source-collection     | Weekly source collection (tiered, resilient)        | shipped               | Shipped 2026-07-24; 234 articles on first run                                   |
| S-02       | geography-ranking-rubric     | Geography-ranking rubric + eval harness             | shipped               | Shipped 2026-07-27; verified against a real 368-article pool                    |
| S-03       | translated-shortlist-view    | Translated shortlist dashboard view ★               | shipped               | Shipped 2026-07-30; reviewed (1 critical fixed); F3 live-translation check open |
| S-04       | story-selection-gate         | Story selection gate (human gate 1)                 | yes                   | S-03 and F-04 both shipped — unblocked                                          |
| S-05       | polish-copy-generation       | Polish copy generation + numeric-integrity gate     | no                    | Needs S-04, F-03                                                                |
| S-06       | brand-visual-assets          | Per-platform brand visual assets                    | no                    | Needs S-05; file Canva access (OQ#2)                                            |
| S-07       | content-approval-gate        | Content approval gate (human gate 2) + reminder     | no                    | Needs S-05, S-06; F-04 shipped — unblocked on that side                         |
| S-08       | scheduled-publishing         | Scheduled per-platform publishing + missed-deadline | no                    | Needs S-07, F-05; reuses publish integ.                                         |
| S-09       | archive-and-learning-loop    | Full-fidelity archive + rubric learning loop        | no                    | Needs S-08, S-02                                                                |
| S-10       | ops-heartbeat-and-catchup    | Ops heartbeat alert + missed-run catch-up           | no                    | Needs F-05                                                                      |

## Open Roadmap Questions

1. ~~**Exact source list, and which sources expose a structured feed (RSS).**~~ — **Resolved 2026-07-24.** 13 candidates verified against live feeds; 9 ship enabled on the RSS tier (La Vanguardia Economía, El Periódico Economía, Expansión Inmobiliario, Expansión Economía, El País Economía, Ara, Nació Digital as primary; 20 Minutos Vivienda, Fotocasa Life as fallback). Idealista has no feed and needs the rendered tier; Cinco Días and El Economista return 403 and need the api tier — all three ship disabled with the failure recorded. Registry lives in `src/lib/collection/sources.ts`. **Consequence:** the operator enabled the two Catalan-language sources, widening FR-013's translation scope from `es→pl` to `{es,ca}→pl` — S-02 and S-03 must handle `ca` source material.
2. **Visual-template (Canva) API access — paid tier, possible access application with external lead time.** — Owner: operator. Block: S-06 (non-blocking to the roadmap, but file the request early).
3. **Carousel length — fixed, or driven by story count?** — Owner: operator. Block: S-06.
4. **Selection granularity — pick the cluster or a specific article within it?** — Owner: operator. Block: S-04.
5. **Retention policy for full-fidelity archive material on local disk.** — Owner: operator. Block: S-09.
6. **Second notification channel for the time-critical Monday reminder?** — Owner: operator. Block: S-07 only (non-blocking; F-04 shipped 2026-07-28 email-only without resolving this — the reminder can ship as email-only too if the operator doesn't ask for a second channel by then).
7. ~~**Late-Sunday news window — shrink to Sun 17:00, or roll into next week?**~~ — **Resolved 2026-07-24: roll into next week.** Windows tile from the previous digest's `collection_completed_at` checkpoint to the current run's start time, so the calendar is covered exactly once and a late-Sunday story is never dropped — it lands in the following run. No declared cutoff to maintain. Implemented in S-01 Phase 4 (`src/lib/collection/window.ts`).
8. **Delivery timeline soft target.** — Owner: operator. Block: roadmap-wide. Resolved stance: `main_goal: quality`, `mvp_weeks` intentionally unbounded; sequence by dependency, not by calendar. Set a soft milestone only if downstream coordination needs one.

## Parked

- **Infographics as an output format** — Why parked: PRD §Non-Goals, dropped permanently; a good infographic is a design act, not fill-in-the-blanks. One output path (templates) instead of two.
- **Podcast / audio digest** — Why parked: PRD §Non-Goals, fast-follow; Polish TTS quality is uneven and audio can't be skimmed. (Specifics — provider, length, distribution — are PRD Open Question #8, deferred with the feature.)
- **Multiple users, roles, or user management** — Why parked: PRD §Non-Goals; single-operator by design.
- **Rebuilding the social publishing integration** — Why parked: PRD §Non-Goals; reused from the prior project, validated across Instagram/Facebook/LinkedIn. S-08 consumes it as-is.
- **Recency-based ranking** — Why parked: PRD §Non-Goals; ranking is by relevance, deliberately not by publication time.
- **Fully autonomous publishing** — Why parked: PRD §Non-Goals; both human gates (selection, approval) are permanent product properties, not scaffolding.

## Done

- **F-02: (foundation) the dashboard is gated by a 6-digit PIN with lockout-after-~5-attempts and rate limiting, reachable only over a private path (Cloudflare Tunnel) — replacing the scaffold's email/password auth, which is the wrong mechanism for this product.** — Archived 2026-07-27 → `context/archive/2026-07-27-operator-pin-access-gate/`. Lesson: —.
- **S-02: (system) the week's articles are semantically clustered (coverage count as a ranking boost, not redundancy) and each cluster is scored by the geography-first rubric from title + lede — with an eval harness that gates any rubric change against known-correct examples.** — Archived 2026-07-27 → `context/archive/2026-07-25-geography-ranking-rubric/`. Lesson: real-pool verification (a live ~368-article digest) surfaced three failure modes no mocked test could — a real UUID costs far more output tokens than expected to echo back, Sonnet 5 runs adaptive thinking by default and silently eats the `maxTokens` budget meant for output, and a single-pass whole-pool LLM call occasionally mis-partitions at scale. All three are now handled (local-id indirection, an explicit `thinking: false` opt-out threaded through F-03's harness, and a corrective retry) — but the lesson generalizes: an LLM call sized and tested only against small mocked inputs can behave qualitatively differently at real production scale, and that gap only shows up by actually running against real data before calling a slice done.
- **F-03: (foundation) a shared wrapper around every model call that enforces a hard per-run cost ceiling and halts on reaching it, with staged malformed-output recovery and bounded backoff retries — so an unattended run can never bill quietly overnight.** — Archived 2026-07-25 → `context/archive/2026-07-24-llm-cost-ceiling-harness/`. Lesson: the vendor exposes no USD budget primitive, so the ceiling is application-side accounting (token `usage` × a price table) — and because the check and the increment are separate round trips, the ceiling is _soft_: under concurrency the overshoot bound is `concurrency × per-call cost`, not one call. S-02's scoring loop must cap its fan-out accordingly.
- **S-01: operator can trigger (or the scheduler can auto-run) a week's collection, pulling articles from a configured source list — resilient to a blocked source and to a thin news week.** — Archived 2026-07-24 → `context/archive/2026-07-24-weekly-source-collection/`. Lesson: the opt-in live smoke test found a real regression within minutes of existing — a source that verified working in the morning was blocking by the afternoon. Fixtures cannot see that class of failure; every slice depending on third-party feeds should ship one.
- **F-01: (foundation) the digest state machine (`collecting → ranking → ready_for_selection → generating → ready_for_approval → approved → published`, plus `skipped`/`failed`) is persisted with per-stage checkpoints, and the core `digest`/`article`/`cluster` tables exist — enough for a multi-day run to survive a machine restart.** — Archived 2026-07-24 → `context/archive/2026-07-22-durable-digest-run-state/`. Lesson: —.
- **F-05: (foundation) a persistent scheduling primitive that fires jobs at a named-zone (`Europe/Warsaw`) wall-clock time correctly across the DST transition and replays a window missed while the machine was off — the timing mechanism the automatic Sunday collection and Tuesday publish plug into.** — Archived 2026-07-30 → `context/archive/2026-07-29-reliable-scheduler-backbone/`. Lesson: —.
- **S-03: operator opens the dashboard and sees the top-15 ranked, translated Polish shortlist (Spanish/Catalan originals alongside) ★ — the north star.** — Not yet archived (open item below); still at `context/changes/translated-shortlist-view/`. Lesson: the impl-review caught a real gap unit tests didn't — scraped `source_url` rendered as a raw clickable link with no scheme check, and a Supabase query error silently rendering identically to "no data." Both are now standard-shape risks (untrusted external content reaching the DOM, error vs. empty-state conflation) worth checking on every new page that queries the DB directly, not just this one. **Open:** F3 — the literal "operator sees real Polish text on a real digest" path is still unverified live; the only real digest predates this feature and a live re-run was deferred on cost grounds. Close this before archiving.
