# Weekly Source Collection — Plan Brief

> Full plan: `context/changes/weekly-source-collection/plan.md`

## What & Why

Build the collection stage of the weekly digest pipeline: pull articles published in a week's window from a configured list of Spanish real-estate sources, so the ranking brain (S-02) has a pool to work on. This is roadmap slice S-01 — the first consumer of F-01's durable run-state, and the first link in the chain to the north-star shortlist view. Without it there is nothing to rank, translate or publish.

## Starting Point

F-01 shipped the schema, the Postgres-guarded state machine and a typed run-state module — and nothing yet writes to any of it. There is no collection code, no source configuration, and no execution context for long-running work: the app is configured for Cloudflare's edge runtime while `tech-stack.md` says the pipeline belongs in a separate long-lived Node worker that does not exist. Two loose ends from F-01 also land here — its migration was applied outside the CLI's migration history, and its data access imports `astro:env/server`, which plain Node cannot resolve.

## Desired End State

`npm run collect` runs a full collection pass and leaves a digest in `ranking` with its article pool persisted, its collection checkpoint set, and a per-source report recording what each source returned. A source that blocks or times out is recorded and skipped without failing the run; a thin week escalates to fallback sources; an empty pool fails the digest with a diagnostic rather than advancing silently. Re-running against a failed digest tops up the pool instead of discarding what was already collected.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Execution runtime | Standalone Node worker entrypoint | Matches `tech-stack.md` verbatim and avoids building on the edge runtime that document calls wrong for long-running work. |
| Source configuration | Typed, zod-validated config module in the repo | Sources are code-shaped config — no migration to add one, reviewable in git, and the data-model sketch deliberately has no source entity. |
| Tier coverage | RSS implemented; API and rendered declared but unimplemented | Proves the abstraction with a real adapter while deferring the vendor choice until the source list says which sources actually need it. |
| AI web search (FR-003 last resort) | Deferred, with an explicit seam | It would be the system's first model spend, and F-03's cost ceiling — which exists to stop exactly that — is not built yet. |
| Window boundary (OQ#7) | Tiling cutoff from the previous digest's checkpoint | Consecutive windows tile exactly, so late-Sunday news defers to next week rather than vanishing, and it reuses an existing column. |
| Collection failure rule | Fail only on an empty pool | Honours US-03 and US-04, while treating zero articles as what it almost certainly is — every source broken, not a quiet week. |
| Re-trigger semantics | Keep existing articles and top up | A run that died partway keeps its work and re-hits fragile sources less, with the existing unique constraint absorbing overlap. |
| Per-source failure record | `collection_report` jsonb on `digest` | Durable and queryable without a new entity; logs on a home Pi are easy to lose and invisible from the dashboard. |
| Thin-week escalation | `primary`/`fallback` role in config + `MIN_POOL_SIZE` | Implements FR-003 with no new machinery and keeps weekly request volume down on normal weeks. |
| Manual trigger surface | CLI only | The worker is unreachable from the Astro runtime, and an ungated collect endpoint before F-02's PIN gate would be a trigger anyone on the tunnel could fire. |
| Testing | Fixtures + opt-in live smoke test | Mirrors the F-01 precedent, keeps CI hermetic, and still catches a source silently changing its feed format. |
| Migration sequencing | Repair F-01's history as Phase 1 | Fixes the blocker while there is exactly one migration to reconcile; it only gets more expensive every slice. |

## Scope

**In scope:** migration-history repair + `collection_report` column + the deferred `window_end >= window_start` check; making run-state runtime-agnostic; the source registry and tier abstraction; the RSS adapter; the collection orchestrator (window tiling, per-source isolation, escalation, top-up insert, state transitions); the `npm run collect` entrypoint.

**Out of scope:** news-API and rendered-fetch tiers; AI web search; the dashboard trigger; the scheduler (F-05); clustering, scoring, ranking and translation (S-02); a `source` database table; fetching article bodies.

## Architecture / Approach

A plain Node entrypoint (`src/worker/collect.ts`) loads env, builds a Supabase service-role client, and resolves or creates the week's digest through F-01's run-state contract. It hands the client and digest to an orchestrator that resolves the collection window from the previous digest's checkpoint, fans out across enabled sources through a common fetch-adapter interface — each inside its own error boundary — filters candidates to the window, inserts articles against the existing unique constraint, escalates to fallback sources if the pool is thin, writes the per-source report, sets the collection checkpoint, and moves the digest to `ranking` or `failed`. Nothing under `src/worker/` may import `astro:env/server`; that constraint is what Phase 2 exists to satisfy.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Migration path & schema | Repaired migration history, `collection_report` column, deferred check constraint | Needs a Supabase login that returned 403 earlier — the phase can stall on a credential |
| 2. Runtime-agnostic data access | Run-state takes an injected client; Node can import it | Changes an API F-01 already shipped; callers must move together |
| 3. Source config & tier abstraction | Validated source registry + working RSS adapter | The source list is unconfirmed (OQ#1); enabled sources depend on which feeds actually verify |
| 4. Collection orchestrator | Window tiling, isolation, escalation, top-up, state transitions | The window-tiling trap — using the digest's own checkpoint would silently skip the recovered week |
| 5. Worker entrypoint & CLI | `npm run collect`, live smoke test, docs | First contact with real feeds; format surprises land here |

**Prerequisites:** F-01 shipped (done); a Supabase login with access to project `arugswrcmlupwyyumugn` for Phase 1; the operator's source list for Phase 3 (partially derivable by verifying candidate feeds).
**Estimated effort:** ~4-5 sessions across 5 phases; Phase 4 is the largest.

## Open Risks & Assumptions

- **Phase 1 depends on a Supabase credential that was unavailable earlier today.** If the login cannot be obtained, the schema change would have to go through the SQL Editor again and the history drift would grow rather than shrink.
- **The source list is still unconfirmed (OQ#1).** The registry is seeded by verifying candidate outlets for working feeds during Phase 3; if most turn out to lack feeds, this slice delivers a thinner pool than the pipeline needs and the API/rendered tiers become urgent.
- **`MIN_POOL_SIZE` is a guess** until several real weeks are observed — too high and fallbacks fire every week, too low and they never do.
- **Undated feed items are kept, not dropped**, on the assumption that feeds list recent content; the risk of pulling in stale evergreen items is bounded by a per-source item cap rather than by the date filter.
- **The live smoke test is only as useful as the discipline to run it** — it is deliberately excluded from CI.

## Success Criteria (Summary)

- The operator can recover a failed week with one command, without waiting seven days (FR-018 / US-02).
- A blocked or broken source produces a recorded failure and a still-usable digest, never a lost week (US-03).
- A thin news week still yields a pool, and the report explains why it was thin without anyone reading logs (US-04).
