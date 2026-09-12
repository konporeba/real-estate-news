---
date: 2026-09-12T14:50:51+02:00
researcher: porebkon
git_commit: 4951b59ebe91d1eb0f88797fe43926e0d3a7f251
branch: main
repository: real-estate-news
topic: "S-07 content approval gate (human gate 2) + Monday reminder — codebase grounding"
tags: [research, codebase, approval-gate, email, scheduler, digest-state-machine, s-07]
status: complete
last_updated: 2026-09-12
last_updated_by: porebkon
---

# Research: S-07 content approval gate (human gate 2) + Monday reminder

**Date**: 2026-09-12T14:50:51+02:00
**Researcher**: porebkon
**Git Commit**: `4951b59`
**Branch**: main
**Repository**: real-estate-news

## Research Question

What already exists in this codebase for roadmap slice **S-07 `content-approval-gate`** (FR-019,
FR-020, FR-021, US-16, US-17) — the operator is emailed that content is ready, reviews the complete
generated post, and approves or rejects it before anything publishes, with a Monday reminder if any
step is still unvalidated — and what are the load-bearing constraints a plan must respect?

## Summary

**S-07 is unusually well pre-built.** Four things it might have had to create already exist:

1. **Both gate transitions are already legal**, in the TypeScript map _and_ the authoritative
   Postgres trigger: `ready_for_approval → approved` and `ready_for_approval → skipped`
   (`src/lib/digest/state-machine.ts:20`). So the approve path needs **no** change to
   `enforce_digest_transition` — which matters, because editing that trigger means reproducing its
   entire body verbatim from the latest defining migration.
2. **The email harness has a complete, tested precedent for exactly this shape of message** — a pure
   builder (`src/lib/email/digest-ready.ts`) plus an entrypoint-composed `notifyDigestReady` that
   can never fail the run (`src/worker/rank.ts:216-250`).
3. **The scheduler takes a second job as pure data** — `SCHEDULED_JOBS` in
   `src/lib/scheduler/registry.ts:15` plus a `JOB_ACTIONS` entry in
   `src/worker/scheduled-run.ts:39`. No migration: `tryAcquireJob` upserts the row on first fire.
4. **The dashboard already renders the rendered visuals** for `ready_for_approval`
   (`src/pages/dashboard/[id].astro:20,164-247`), including the three-way error/partial/empty
   distinction the approval view needs.

What S-07 genuinely has to invent is narrow: **where a rejection goes** (the state machine has no
`rejected` and no reverse edge), **what the approval record looks like** (nothing persists a
decision today), **the generated-copy review UI** (`generated_copy` has never been read by the app),
and **the reminder job's scope** ("any step unvalidated" spans two human gates, not one).

Three constraints will shape the plan more than the feature will:

- **`npx supabase db push` and `gen types` are both unusable on this project.** Every migration is
  applied by hand through the SQL Editor and every type is hand-edited into
  `src/db/database.types.ts:1-35`. The `supabase migration repair` debt stands at **eight**
  versions; an S-07 migration makes it nine.
- **There is no test infrastructure for `src/pages/` routes or React components at all** — Vitest
  collects only `src/**/*.test.ts` and no DOM environment is configured. The established substitute
  is a lib-level integration suite plus a SQL↔TS drift guard.
- **`DASHBOARD_BASE_URL` still has no real value** (no Cloudflare Tunnel host exists yet), which is
  S-04's still-open carried-forward item 5.6. FR-019's email CTA inherits that gap.

## Detailed Findings

### 1. The digest state machine — the approve path is already open, the reject path is not

`src/lib/digest/state-machine.ts:14-30` (mirrored by, and subordinate to, the
`enforce_digest_transition` trigger):

```
rendering           → ready_for_approval | failed
ready_for_approval  → approved | skipped | failed
approved            → published | skipped | failed
skipped             → published                       -- US-19 manual publish later
failed              → collecting | generating | rendering
published           → (terminal)
```

- **Approve** is `ready_for_approval → approved`. Legal today. No migration.
- **Reject has no state of its own.** The only non-failure exit is `skipped`, which is already
  spoken for: F-01's plan defines it as US-19's _missed-deadline_ state
  (`context/archive/2026-07-22-durable-digest-run-state/plan.md:51`), and `skipped → published`
  exists precisely so a missed-deadline digest stays manually publishable. Routing "the operator
  rejected this copy" into the same state makes a rejected digest manually publishable too, and
  leaves S-08 unable to tell the two apart.
- **No operator-facing `skipped` control has ever been built.** S-04 declined it explicitly:
  "The state machine permits `ready_for_selection → skipped`, but no operator control for it is in
  scope" (`context/archive/2026-08-01-story-selection-gate/plan.md:47`). S-07 would be the first.
- `TERMINAL_STATES = ["published", "skipped", "failed"]` are exactly the states excluded from the
  `one_active_digest_per_week` partial unique index (`state-machine.ts:32-40`), so anything that
  moves a digest _out_ of a terminal state can collide with a live digest for the same week.

**Drift guard**: `src/lib/digest/state-machine.test.ts:15-26` reads the migration directory at module
load, picks the _latest_ file containing `enforce_digest_transition`, regex-parses the allowed map
(`:29-38`) and asserts full parity with the TS map projected over
`Constants.public.Enums.digest_status` (`:140-154`). Any transition change must therefore reproduce
the whole trigger body in a new migration — S-06 flagged this at
`context/archive/2026-09-08-brand-visual-assets/plan.md:56-58`.

### 2. What the approval view has to show — `generated_copy` has never been read by the app

`supabase/migrations/20260906150000_generated_copy.sql:27-61`. One row per **selected** cluster:

| column                                         | note                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `polish_title`, `caption_summary`, `body_copy` | FR-013's outputs, all `not null` — "a partial row would reach the S-07 approval gate looking publishable" (`:31-32`)                                                 |
| `key_statistics`                               | jsonb array of `{label, value}`                                                                                                                                      |
| `source_text_origin`                           | `'article'` \| `'lede'` — commented: _"The operator sees this at the S-07 approval gate, so a post that reads short is explained rather than mysterious"_ (`:38-41`) |
| `source_char_count`                            | diagnostic — distinguishes "fallback fired" from "the article was thin"                                                                                              |

The table comment states the hand-off outright (`:66`): _"S-06 fills visual template slots from these
columns; S-07 renders them at the approval gate."_ No query against `generated_copy` exists anywhere
under `src/pages/` today.

Visuals are already loaded: `src/pages/dashboard/[id].astro:164-247` reads `generated_asset`, signs
every path in **one** `createSignedUrls` call against the private `digest-assets` bucket
(`src/lib/digest/assets.ts:9-16`, TTL 600s at `:24`), and keeps three outcomes apart — total failure,
partial failure, and "the stage hasn't run" — with a comment recording that `createSignedUrls`
reports per entry and returns `error: null` even for a nonexistent bucket (`:200-206`).

**Pre-existing data caveat, already recorded**: _"Digests already sitting in `ready_for_approval`
predate this stage and have no assets. The preview renders them as an empty strip rather than an
error, and no backfill is attempted"_ (`context/archive/2026-09-08-brand-visual-assets/plan.md:626`).

### 3. FR-019's email — the precedent is exact

`src/lib/email/digest-ready.ts` is a **pure builder**: `buildDigestReadyEmail(digest, items, baseUrl)
→ EmailRequest`, no transport, no I/O (`:74-96`). The side effect lives at the entrypoint:
`notifyDigestReady` in `src/worker/rank.ts:216-250`, whose contract is written in its own docstring:

> "Composed at the entrypoint rather than inside `rankDigest()` … the ranking library stays free of
> side effects that aren't ranking. **Never fails the run.**"

Every failure path returns rather than throws; `not_configured` logs at info level, anything else
logs an error, and the exit code stays `0` — because `runCollectionJob` in `scheduled-run.ts` reads
that exit code as the job's outcome (`context/archive/2026-08-01-story-selection-gate/plan.md:334-338`).

**Insertion point for FR-019**: `src/worker/visuals.ts:main`, after `fetchAssets`/`summarize`
(`:195-198`). `renderDigest` is what reaches `ready_for_approval`
(`src/lib/visuals/render.ts:518`), and `visuals.ts` already holds the `env` and the client.

Harness API available: `sendEmail(transport, to, request)` never throws, returns
`not_configured | invalid_recipient | send_failed` (`src/lib/email/send.ts:34-64`);
`EmailContent = { heading, bodyHtml, bodyText?, cta? }` where `bodyHtml` is **raw trusted HTML** and
external text must be passed through `escapeHtml()` first (`src/lib/email/layout.ts:26-37,69`);
`renderArticleCards(cards)` is the generic card primitive (`:191`).

`DASHBOARD_BASE_URL` is optional by design — "an unset value sends the notification without a button
rather than one pointing nowhere" (`src/worker/env.ts:29-31`, `.env.example:39-43`).

### 4. FR-021's Monday reminder — the scheduler is ready, but the scope is ambiguous

Adding a job is two data edits and no migration:

- `src/lib/scheduler/registry.ts:15` — `SCHEDULED_JOBS`, currently only
  `{ name: "collection", schedule: { dayOfWeek: 0, hour: 17, minute: 0 } }`. The file header says a
  second entry lands "with zero changes to `src/lib/scheduler/schedule.ts` or the orchestration
  entrypoint's due-check loop" (`:1-5`). Note every prior slice assumed that second entry would be
  **S-08's publish**; nobody has reserved a name for the reminder.
- `src/worker/scheduled-run.ts:39-40` — `JOB_ACTIONS: Record<string, JobAction>`.
- No seed row needed: `tryAcquireJob` upserts on first invocation
  (`context/archive/2026-07-29-reliable-scheduler-backbone/plan.md:172-173`).

`WeeklySchedule` is `{ dayOfWeek: 0|1|…|6 (0 = Sunday), hour, minute }` in `Europe/Warsaw`
(`src/lib/scheduler/schedule.ts:89-94`). `isJobDue` compares only against the single most recent
scheduled instant, so any outage collapses to exactly one catch-up fire (`:122-125`).

**Two behaviours a plan must decide about, not inherit:**

- `isJobDue(schedule, null, now) === true` — a **brand-new** job with no `last_fired_at` is due on
  the very first `scheduled-run` invocation, whatever day it is (`schedule.ts:124`, asserted at
  `schedule.test.ts:48-50`). The reminder will therefore fire once immediately on deploy.
- FR-021 says _"if any step remains unvalidated"_ and US-17 says the email tells the operator
  _"which step is outstanding"_ — that is broader than approval. The two human gates are
  `ready_for_selection` (S-04) and `ready_for_approval` (S-07).

**No scheduler-level retry** is by design: "a failed run is recovered by the next scheduled fire"
(`context/archive/2026-07-29-reliable-scheduler-backbone/plan.md:90-91`).

### 5. The write path — `confirm_selection` is the template to copy

S-04 established the whole shape, and it transfers almost verbatim.

**RPC** (`supabase/migrations/20260829120000_selection_gate.sql:93-183`):
`security definer`, `set search_path = public`, opens with
`select status into v_status from digest where id = p_digest_id for update` — the `FOR UPDATE`
serialises concurrent confirms so the second reads the _new_ status and fails cleanly rather than
racing (`:114-116`). Each rejection raises a distinct SQLSTATE (`SG001`–`SG005`), and it was
**verified during S-04** that PostgREST passes custom SQLSTATEs through to `error.code` unmodified
(`context/archive/2026-08-01-story-selection-gate/change.md:12-15`). The status is checked explicitly
first so the operator gets a specific message rather than the trigger's `check_violation`
(`plan.md:60`).

**API route** (`src/pages/api/selection/confirm.ts`): `export const prerender = false`, and the order
is load-bearing — a 401 on `!context.locals.operatorAuthenticated` **before** the body is read,
because `PROTECTED_ROUTES` in `src/middleware.ts:7` covers only `/dashboard` and answers with a 302
that a `fetch()` caller would follow and then fail to parse as JSON (`confirm.ts:65-70`). Then zod
validation from a shared rules module (400), service client (503), one RPC, and a `Map` from SQLSTATE
to `{ reason, status, message }` — a Map rather than a Record so the miss is honestly typed
`| undefined` (`:26-45`). Postgres's own message text never reaches the response.

**Shared rules module** (`src/lib/selection/rules.ts`): imported by _both_ the route and the island so
the affordance and the enforcement cannot disagree; kept as `.ts` (not `.tsx`) because Vitest cannot
collect `.tsx` (`:1-14`). Its drift guard (`rules.test.ts:147-199`) parses the migration for the
numeric bounds and enum members.

**Island + hook**: `src/components/SelectionForm.tsx` with `client:load`, state in
`src/components/hooks/useSelection.ts`, per CLAUDE.md's convention. `SelectionForm`'s header states
the reason it hydrates at all: _"confirming is irreversible: `ready_for_selection -> generating` has
no way back in the state machine, so a review step stands between the checkboxes and the transition"_
(`:1-7`) — the same argument applies to approving.

### 6. Testing — what is possible, and what is not

- **Vitest collects `src/**/\*.test.ts` only** (`vitest.config.ts:18`). No jsdom, no component testing,
**no test anywhere for any `src/pages/` route or React component**. The established substitute is
a lib-level integration suite (`src/lib/selection/confirm.test.ts` tests the RPC directly, never
  the route) plus a drift guard.
- **Integration suites** gate on `SUPABASE_TEST_PROJECT=1` + URL + service key, then
  `describe.skipIf(!configured)`, and isolate by claiming a **synthetic year** for their week windows
  (1970, 1971, 2991-3002, 3100, 3200 are taken; **3003+, 3101-3199, 3201+ are free**). Each suite
  re-declares its own `configured`/`serviceClient`/`unwrap`/`purge` block — there is no shared helper.
  `fileParallelism: false` because they share the `digest` table.
- **`src/lib/selection/confirm.test.ts:5-9` sets the standard for a gate**: _"Every rejection case
  therefore asserts twice: that the call failed with the expected SQLSTATE, AND that the digest is
  still in `ready_for_selection` with no selection row behind it."_
- **Email**: `fakeEmailTransport(outcomes)` in `src/lib/email/testing.ts` throws loudly if called more
  often than staged (`:29`); builders are tested as pure functions on `bodyHtml` substrings
  (`digest-ready.test.ts`); the worker-side notify is tested for the property that it _cannot fail the
  run_ (`src/worker/rank.test.ts:136-200`) — the direct template for FR-019.
- **Scheduler**: `src/worker/scheduled-run.test.ts` drives `runScheduledJobs` with an **ad-hoc
  registry and a fake action** (`:53-63,83-85`), never the real `SCHEDULED_JOBS`, so adding a registry
  entry needs no test change — only a new case if the action has distinct semantics.
- **CI** (`.github/workflows/ci.yml:18-24`) runs `lint`, `test`, `build` with **no Supabase secret**, so
  every integration suite self-skips there. Only unit tests and drift guards actually gate a PR.
- **Env prefixes are whitelisted** in `vitest.config.ts:39`
  (`SUPABASE_ COLLECTION_ GMAIL_ OPERATOR_ GOOGLE_ SLIDES_`). A new prefix that isn't added there
  makes its suite silently skip.

### 7. Migrations and generated types — both normal paths are broken

`src/db/database.types.ts:1-35` is a **generated file maintained by hand**: `gen types` returns
"account does not have the necessary privileges" for this project, so every table, enum member and
RPC since F-03 has been hand-written into it and recorded in the header's exception list. An S-07
table/RPC must do the same and add its own entry.

`context/archive/2026-09-08-brand-visual-assets/plan.md:615-624` is the current authoritative statement:

> "**The `supabase migration repair` debt was NOT cleared, and now stands at eight versions**:
> `20260829120000`, `20260829130000`, `20260906140000`, `20260906141000`, `20260906150000`,
> `20260908120000`, `20260908130000`, `20260908140000` — all applied by hand and absent from
> `supabase_migrations.schema_migrations`. … `supabase migration list` and `--db-url` against the
> session pooler both fail with `LegacyDbConnectError: Connection timed out`, and the direct host
> `db.<ref>.supabase.co` no longer resolves at all. … Clearing it needs a machine that can complete a
> Postgres connection to the project."

So an S-07 migration is **debt version nine**, must be applied through the SQL Editor by hand, and
its Progress row should follow S-06's wording convention — the debt is "either cleared or explicitly
re-recorded as still outstanding" (`plan.md:227`, row 1.5 at `:653`) — so it cannot be silently skipped.

## Code References

- `src/lib/digest/state-machine.ts:14-40` — transition map and terminal states; `ready_for_approval → approved | skipped | failed` already legal
- `src/lib/digest/state-machine.test.ts:15-26,140-154` — migration-parsing drift guard
- `src/lib/digest/run-state.ts:85-117` — `transitionDigest`, guarded app-side and DB-side, scoped to the status it read
- `src/lib/digest/assets.ts:9-24` — `ASSET_BUCKET`, `SIGNED_URL_TTL_SECONDS`
- `src/pages/dashboard/[id].astro:20,164-247,251` — rendered statuses, asset signing, the three-way failure distinction, `selectionOpen`
- `src/pages/api/selection/confirm.ts:26-45,63-108` — SQLSTATE map and the auth-before-body ordering
- `src/lib/selection/rules.ts:1-98` — the shared-rules pattern the approval route should mirror
- `src/components/SelectionForm.tsx:1-7`, `src/components/hooks/useSelection.ts:1-10` — island/hook split
- `src/lib/email/send.ts:34-64`, `src/lib/email/layout.ts:26-37,61-70,191` — harness API
- `src/lib/email/digest-ready.ts:74-96` — pure builder precedent
- `src/worker/rank.ts:196-250` — `notifyDigestReady`: entrypoint-composed, never fails the run
- `src/worker/visuals.ts:175-198` — where FR-019's send belongs
- `src/lib/visuals/render.ts:511-519` — checkpoint + `ready_for_approval` transition
- `src/lib/scheduler/registry.ts:8-16`, `src/lib/scheduler/schedule.ts:89-125`, `src/worker/scheduled-run.ts:39-40,54-131` — the job-registration surface
- `src/worker/env.ts:20-31` — optional email/dashboard config, and the base64 lesson from `PIN_PEPPER`
- `src/middleware.ts:7-16` — `PROTECTED_ROUTES = ["/dashboard"]`, 302 for unauthenticated
- `supabase/migrations/20260906150000_generated_copy.sql:27-79` — the table the approval view renders
- `supabase/migrations/20260908140000_visual_assets.sql:75-117` — `generated_asset`, `rendering_completed_at`
- `supabase/migrations/20260829120000_selection_gate.sql:93-183` — the RPC template
- `src/db/database.types.ts:1-35,460-548` — hand-maintained types and the exception ledger

## Architecture Insights

- **Every gate is enforced three times** — island affordance, API/zod, and an authoritative Postgres
  function or trigger — with a test that parses the SQL and fails if the TypeScript mirror drifts.
  Any constant S-07 duplicates between SQL and TS needs its own drift guard.
- **Side effects live at entrypoints, never in libraries.** `rank.ts`/`visuals.ts` compose email and
  logging around a pure-ish library orchestrator. This is what keeps `src/lib/ranking` and
  `src/lib/visuals` importable by tests without a transport.
- **Notification can never fail the pipeline.** The digest is already persisted by the time an email
  is attempted, so a missing credential logs and returns.
- **Error state and empty state are never conflated.** S-03's impl-review F2 made this a house rule,
  and `[id].astro` now distinguishes error / partial / not-yet-run for assets. The approval view
  inherits the obligation for `generated_copy`.
- **An error branch that sets a flag without returning is the repo's known footgun** (S-04's
  impl-review warning; `astro/tsconfigs/strict` omits `noUncheckedIndexedAccess`). `[id].astro`
  already carries a comment about surviving exactly this (`:110-118`).
- **The runtime boundary is lint-enforced both ways.** A `src/pages/` route may **not** import
  `@/lib/email/*` or `@/lib/scheduler/*` (`eslint.config.js:74-97`); worker code may not import
  `astro:env/server` or `@/lib/supabase-admin` (`:107-135`). So the approval _email_ is worker-side,
  the approval _route_ is app-side, and they share only the database and `src/lib/digest/`.

## Historical Context (from prior changes)

- `context/archive/2026-07-22-durable-digest-run-state/plan.md:51,96-106` — the original state
  machine, and `skipped`'s meaning as US-19's missed-deadline state
- `context/archive/2026-08-01-story-selection-gate/plan.md:15,47,60,226-228,334-338` — gate
  irreversibility, the deliberate absence of any `skipped` control, the API-route contract, the
  never-fail email wiring
- `context/archive/2026-09-06-polish-copy-generation/plan.md:397-399` — hand-applied migrations, hand-edited types
- `context/archive/2026-09-08-brand-visual-assets/plan.md:98,615-627` — "FR-019/020/021 belong to
  S-07"; the eight-version migration debt; digests already in `ready_for_approval` have no assets
- `context/archive/2026-09-08-brand-visual-assets/verification.md` — the live-verification artifact
  format, with section headings carrying the Progress row number they discharge (`(7.1)`, `(7.3)`…)
- `context/changes/outbound-email-notifications/plan.md:5,26,29` — F-04 built the capability and
  deferred FR-019 and FR-021 to this slice by name; OQ#6 left open

## Related Research

None of the prior changes wrote a `research.md`; this is the first.

## Open Questions

### Resolved by the operator, 2026-09-12 (before planning)

1. **What does "reject" (FR-020) mean in the state machine?** → **A new `rejected` enum member.**
   `ready_for_approval → rejected`, and a rejected digest is **not** publishable — which is the whole
   point of keeping it out of `skipped`, whose `skipped → published` edge exists for US-19's
   missed-deadline case. Costs a migration that reproduces the `enforce_digest_transition` body in
   full, redefines the `one_active_digest_per_week` predicate to exclude `rejected`, and updates the
   TS map plus `TERMINAL_STATES` in lockstep (the drift guard parses both).
2. **What does the Monday reminder cover?** → **Both human gates.** A digest in
   `ready_for_selection` _or_ `ready_for_approval`, with the email naming which step is outstanding
   (US-17). Silent when nothing is outstanding. Stalled/failed digests stay S-10's business.
   Schedule: **Monday 09:00 `Europe/Warsaw`** — a full day before Tuesday 17:00.
3. **OQ#6 — second notification channel?** → **No. Email only.** OQ#6 closes as "no"; revisit only
   if a Monday is actually missed.
4. **Where does the approval review live?** → **A dedicated `/dashboard/[id]/approve` route.**
   `[id].astro` links to it; FR-019's email CTA points straight at it.

### Still open, for the plan to settle

5. **Does a rejection capture a reason?** Not asked; the plan's working assumption is **yes, an
   optional free-text note** on the approval record — it is nearly free here, and FR-025's learning
   loop (S-09) is the consumer, exactly as S-04 already persists passes as well as picks.
6. **Is `rejected` fully terminal, or recoverable?** The plan's working assumption is
   `rejected → generating`, mirroring the `failed → generating` edge S-05's impl-review added so a
   cheap failure need not re-pay the whole ranking stage. Like that edge, it can collide with the
   `one_active_digest_per_week` index if another digest is live for the week — the same, already
   accepted, behaviour as re-triggering a `failed` digest.
7. **Does the FR-019 email embed the rendered images?** The bucket is private with a 600s signed-URL
   TTL; embedding means minting a much longer-lived URL into an email. The alternative is copy in the
   email plus a CTA to the dashboard — but the CTA needs `DASHBOARD_BASE_URL`, which is still unset
   (S-04 carried-forward item 5.6: no Cloudflare Tunnel host exists yet).
