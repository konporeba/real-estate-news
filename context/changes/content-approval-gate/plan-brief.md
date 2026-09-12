# Content Approval Gate (S-07) — Plan Brief

> Full plan: `context/changes/content-approval-gate/plan.md`
> Research: `context/changes/content-approval-gate/research.md`

## What & Why

The pipeline now runs unattended all the way to `ready_for_approval` and then stops dead — nobody is
told, the generated copy is invisible to the operator, and no control moves the digest forward. S-07
closes that: an email when content is ready, a page showing the complete post, an explicit approve or
reject, and a Monday reminder for anything still unvalidated. It is the last thing standing between
the pipeline and S-08's scheduled publishing.

## Starting Point

Everything upstream ships: selection (S-04), Polish copy (S-05), rendered cards (S-06). The digest
state machine already permits `ready_for_approval → approved`, the dashboard already signs and
renders the card images, and F-04's email harness already has a tested pure-builder + never-fail-the-
run pattern from FR-010. What does not exist: any `rejected` state, any persisted record that a human
decided anything, any query against `generated_copy` from the app, and any second scheduled job.

## Desired End State

`npm run visuals` finishes and the operator gets an email with the week's stories and a button. The
approval page shows each story's Polish title, caption, body and key statistics — the statistics
beside the original title/lede and a link to the source, so a suspect figure can be traced without
leaving the page — plus the rendered cards. Approve opens a summary of exactly what will publish and
where, then commits to `approved`. Reject, with an optional note, goes to `rejected`, from which
`npm run generate` produces fresh copy on the same confirmed selection. Monday 09:00 `Europe/Warsaw`,
a digest still at either human gate produces one email naming the outstanding step.

## Key Decisions Made

| Decision              | Choice                                    | Why (1 sentence)                                                                                                                                                 | Source   |
| --------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Where rejection goes  | A new terminal `rejected` state           | `skipped` means US-19's missed deadline and stays manually publishable, so reusing it would make a rejected digest publishable and blind S-08 to the difference. | Research |
| Rejection recovery    | `rejected → generating`                   | Mirrors the `failed → generating` edge S-05 added so a cents-sized copy problem needn't re-pay the ranking stage.                                                | Plan     |
| Rejection reason      | Optional free-text note                   | Nearly free now, and FR-025's learning loop is the consumer — the same logic behind S-04 storing passes as well as picks.                                        | Plan     |
| Reminder scope        | Both human gates, Monday 09:00            | FR-021 says "any step unvalidated" and US-17 says the email names it; a full day before Tuesday 17:00.                                                           | Research |
| Reminder when clear   | Silent                                    | An inbox that only ever contains real action items stays trustworthy; detecting a dead reminder is S-10's job.                                                   | Plan     |
| Second channel (OQ#6) | No — email only                           | Closes a roadmap open question deferred twice; revisit only if a Monday is actually missed.                                                                      | Research |
| Approval UI location  | Dedicated `/dashboard/[id]/approve`       | `[id].astro` is already 318 lines with five query branches, and S-04's review found a crash born of exactly that accumulation.                                   | Research |
| Approve friction      | Two-step review then confirm              | Same argument `SelectionForm` makes for gate one — irreversible, and unattended publishing follows it.                                                           | Plan     |
| Email contents        | Copy + CTA, no embedded images            | The bucket is private with short-lived signed URLs; nothing time-limited belongs in a message read days later.                                                   | Plan     |
| Fact-check affordance | Key statistics beside the source original | S-05's lesson was that figures get verified by tracing them back, and FR-014's gate has already produced one false failure.                                      | Plan     |

## Scope

**In scope:** the `rejected` state and its migrations; an `approval` table and one-transaction
`record_approval` RPC; `POST /api/approval/decide` with a shared rules module; the approval page,
story card and island; FR-019's email wired into `npm run visuals`; FR-021's Monday reminder job plus
a manual `npm run remind`; live verification on a real digest.

**Out of scope:** publishing and the `publication` table (S-08); FR-023's missed-deadline behaviour
(S-08); archive browsing and rubric feedback (S-09); the heartbeat / dead-man's-switch (S-10); any
second notification channel; an operator control for `skipped`; editing generated copy; backfilling
digests that predate the rendering stage.

## Architecture / Approach

The runtime boundary splits the slice cleanly and lint enforces it: the **worker** side owns both
emails (`src/lib/email/approval-ready.ts`, `src/lib/email/reminder.ts`, wired at the `visuals.ts` and
`scheduled-run.ts` entrypoints), the **app** side owns the page, island and API route, and the two
share only the database and `src/lib/digest/`. The write path is the repo's standard three-layer
gate: island affordance → zod in a shared rules module → an authoritative Postgres function, with
the transition trigger as the last word beneath all of it, and a test that parses the SQL so the
TypeScript mirror cannot drift.

## Phases at a Glance

| Phase                      | What it delivers                                                  | Key risk                                                                                     |
| -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1. The `rejected` state    | Two migrations, TS map, hand-edited types, `generate.ts` recovery | Touches the most drift-guarded surface in the repo; enum value must be alone in its own file |
| 2. Approval record + RPC   | `approval` table, `record_approval`, integration suite            | Getting the SQLSTATE vocabulary and the double-decision guard right                          |
| 3. Rules + decide endpoint | Shared zod contract, `POST /api/approval/decide`                  | Auth must 401 before the body is read, or `fetch` follows a 302                              |
| 4. Approval page + island  | The operator-facing gate                                          | New page, no component test coverage exists; error-vs-empty conflation                       |
| 5. FR-019 email            | Approval-ready notification                                       | Must never fail the render run                                                               |
| 6. FR-021 reminder         | Monday 09:00 job + `npm run remind`                               | New job fires once immediately on first `scheduled-run`, by design                           |
| 7. Live verification       | A real digest through the gate + `verification.md`                | The path only real data exercises — S-02's lesson                                            |

**Prerequisites:** S-05, S-06 and F-04 shipped (all done). SQL Editor access to the Supabase project.
Gmail credentials for the live email checks. `DASHBOARD_BASE_URL` is still unset — the CTA can only
be verified against `localhost` until a Cloudflare Tunnel host exists.

**Estimated effort:** ~4-6 sessions across 7 phases; Phases 1-3 are mechanical against strong
precedent, Phase 4 is the largest, Phase 7 depends on a real weekly digest being available.

## Open Risks & Assumptions

- **The `supabase migration repair` debt reaches ten versions here.** It could not be cleared from
  this machine (pooler connection times out, direct host does not resolve). Phase 1 requires it to be
  re-recorded explicitly rather than skipped.
- **`DASHBOARD_BASE_URL` has no production value yet** — S-04's carried-forward item 5.6. Both new
  emails inherit it; both omit the CTA rather than emit a broken link, so this degrades rather than
  breaks.
- **No test can cover the page or the island** — Vitest collects `src/**/*.test.ts` with no DOM
  environment. Phases 3 and 4 lean on manual verification by design, not by omission.
- **The reminder fires once on first deploy** whatever the weekday, because a job with no
  `last_fired_at` is due. Correct behaviour, but surprising if unrecorded.
- **Assumption**: rejecting and regenerating is a rare path. If it turns out to be weekly, the plan's
  decision not to attach operator feedback to the regeneration prompt should be revisited.

## Success Criteria (Summary)

- The operator learns by email that content is ready, and can judge the complete post — copy,
  figures, and cards — on one page without leaving it to check a number.
- Nothing reaches `approved` without an explicit two-step confirmation, and a rejected week is never
  publishable but is recoverable the same week.
- A Monday with an outstanding gate produces exactly one email naming it; a clear Monday produces
  none.
