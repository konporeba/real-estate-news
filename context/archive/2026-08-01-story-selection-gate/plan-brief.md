# Story Selection Gate (S-04) — Plan Brief

> Full plan: `context/changes/story-selection-gate/plan.md`

## What & Why

The pipeline currently ranks and translates a shortlist, parks the digest in `ready_for_selection`, and stops — nothing tells the operator, and nothing lets him act. This slice builds the first of the product's two permanent human gates: pick 2–4 stories from the top-15, choose a format and target platforms, confirm, and the digest moves to `generating`. Every shortlisted story is recorded as picked or passed, because those labels are the raw material for the learning loop (S-09) that is supposed to make selection easier week over week.

## Starting Point

`digest`, `cluster`, and `article` exist; `selection` was explicitly deferred by F-01's schema comment. `/dashboard/<id>` renders the ranked, translated shortlist read-only behind the PIN gate. `src/worker/rank.ts` fetches that shortlist only to print it to the console. There is no domain API route (only `verify-pin`), no hydrated React island anywhere in the app, and no pipeline stage yet calls the F-04 email harness.

## Desired End State

The operator receives an email listing all 15 ranked stories with a link. Opening it, each card shows the Polish translation *and* the Spanish/Catalan original, language-flagged, with a checkbox. A live counter enforces 2–4; a format radio and platform checkboxes apply to the whole selection; a review step precedes an irreversible confirm. Afterwards the page renders read-only with the picks marked, the digest sits in `generating`, and `selection_item` holds 15 labeled rows.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| -------- | ------ | ---------------- |
| Selection granularity (PRD OQ#4) | The **cluster**, not an article within it | Only one article per cluster is translated, so the cluster is the only unit the operator can actually read in Polish. |
| Picks/passes storage | `selection` (per digest) + `selection_item` (per shortlisted cluster, `picked boolean`) | Picks and passes differ only by a flag — one table, one query for S-09, and the 2–4 rule is a constraint on `picked = true`. |
| Format & platform scope | One format + one platform set per digest | Matches FR-012 as written; per-story would multiply S-05/S-06 combinations for flexibility nobody asked for. |
| Reversibility | One-way, guarded by a UI review-and-confirm step | Leaves the state machine (SQL trigger + TS map + drift test) untouched and guards the misclick where it happens. |
| Email trigger point | End of `rank.ts:main()` | It already fetches the shortlist to print it, and entrypoint composition is the `scheduled-run.ts` precedent. |
| Email content | All 15 as tier-colored article cards + CTA | `renderArticleCards()` was built in F-04 precisely because the operator asked for this visibility. |
| UI model | Hydrated React island | The 2–4 counter and confirm step are the "interactivity is needed" case CLAUDE.md reserves React for. |
| Write atomicity | One `confirm_selection` Postgres function | The codebase's established answer for what PostgREST can't express; makes a half-written selection structurally impossible. |
| Post-confirm view | Read-only shortlist with picks marked | Makes the page the durable record of the decision, so S-09's archive view is mostly pre-built. |
| FR-009a gap | Fixed here, as its own phase | The selection gate is exactly where checking a translation against its source matters most. |

## Scope

**In scope:** `selection` + `selection_item` schema and the atomic confirm RPC; the selection UI island and its API route; the read-only post-confirm view; the FR-010 digest-ready email; and closing the FR-009a "original alongside" gap (which requires adding `article.language`).

**Out of scope:** any generation (S-05); the `feedback_label` table and rubric feedback (S-09); per-story format/platform; an undo path; article-level selection; an archive view; retention/snapshot columns (OQ#5 unresolved); a `skipped` control; the pre-existing migration-history repair debt.

## Architecture / Approach

Bottom-up, five independently verifiable phases. The database goes first and carries the invariants, because the write path spans two tables plus a digest transition that must be all-or-nothing. The shortlist card is completed *before* controls are added to it, so its layout settles once. Selection rules live in a plain-TS module (`src/lib/selection/rules.ts`) that both the API route and the island import — one authority, and the only place the 2–4 rule is expressed in TypeScript. The island is deliberately presentational because Vitest cannot collect `.tsx`. The email lands last: worker-side, and dependent on nothing the UI touches.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| ----- | ---------------- | -------- |
| 1. Schema & confirm RPC | Two tables + `confirm_selection` transaction | Business rules now live in SQL *and* zod — they must agree |
| 2. FR-009a original alongside | `article.language` + both-language card | Backfill keyed on `source_name` string matching |
| 3. Rules module & API route | `src/lib/selection/rules.ts` + `POST /api/selection/confirm` | Middleware doesn't cover `/api/*` — the route must do its own 401 |
| 4. Selection island & post-confirm view | The operator-facing gate | First hydrated island in the codebase; not unit-testable |
| 5. FR-010 email | Digest-ready notification from `rank.ts` | An email failure must never fail the ranking job |

**Prerequisites:** S-03 and F-04, both shipped. Supabase SQL Editor access (migrations are applied by hand on this project). Gmail credentials and `OPERATOR_EMAIL` configured for Phase 5's manual verification, plus a tunnel hostname for `DASHBOARD_BASE_URL`.

**Estimated effort:** ~3–4 sessions across 5 phases; Phases 1 and 4 are the substantial ones.

## Open Risks & Assumptions

- **`database.types.ts` must be hand-edited.** Its header records that `supabase gen types` returns a privileges error for this project. Three of the five phases touch it; a mistake surfaces as type errors across the route and both pages.
- **The digest lands in `generating` with no worker to advance it** until S-05 ships. This mirrors S-01 leaving digests in `ranking`, but it means a confirmed digest is genuinely stuck in the interim — and there is no undo.
- **Confirmation is irreversible**, guarded only by a UI review step. If that proves too thin in real use, adding `generating → ready_for_selection` later means changing the SQL trigger and the TS map together.
- **The roadmap's S-03 "Delivered" note is inaccurate** — it claims the original is shown alongside, which the code does not do. The note needs correcting when this slice lands.
- **`article.language` backfill matches on `source_name` literals.** If a source is ever renamed in the registry, historical rows keep the language they were backfilled with (correct), but the match itself is a one-time string dependency.

## Success Criteria (Summary)

- The operator gets an email on Sunday, opens the link, and can see each story in Polish next to its Spanish or Catalan original.
- He can select 2–4 stories with a format and platforms, review the choice, and confirm — after which the digest is `generating` and the page shows what he decided.
- Every shortlisted story is on record as picked or passed, ready for S-09 to learn from.
