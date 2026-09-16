# Scheduled Publishing (S-08) — Plan Brief

> Full plan: `context/changes/scheduled-publishing/plan.md`

## What & Why

S-08 is the final step of the publish loop: once the operator has approved a digest (or missed the deadline and it's `skipped`), the generated copy and rendered visuals get posted to Instagram, Facebook, and LinkedIn — automatically at Tuesday 17:00 `Europe/Warsaw`, or manually from the dashboard at any later time. Per-platform success/failure is recorded independently, so one platform failing never blocks or hides the others (US-20).

## Starting Point

Everything upstream is already shipped: the digest state machine already has `approved → published` and `skipped → published` transitions ready to go, `selection` already stores the operator's chosen platforms, `generated_copy` already has caption-ready text per story, and `generated_asset` already has the rendered per-slide images in a private bucket. No `publication` table and no platform-publishing code exist yet — this slice builds both from a clean slate, following this codebase's established harness/worker/scheduler conventions.

## Desired End State

An approved digest reaches every selected platform with no further operator action required, and a missed deadline never silently loses the week — the operator can always trigger it manually later. Every attempt, success or failure, is visible per platform, and nothing is ever posted twice to a platform that already succeeded.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|---|---|---|---|
| Integration approach | Build Instagram/Facebook/LinkedIn from scratch against each platform's real API | The prior project's validated integration isn't available to hand over, so this plan builds it directly — a deliberate departure from the PRD's Non-Goal, reconciled in Phase 6 | Plan |
| Account model | Business/Page accounts (IG Business + FB Page + LinkedIn Company Page) | The only combination Meta's Graph API and LinkedIn's API actually support for programmatic posting | Plan |
| Media hosting | Short-lived signed URLs from the existing private Supabase bucket | Reuses the exact signed-URL pattern the approve page already uses; no new storage infra | Plan |
| Carousel shape | One native multi-image post per platform, not one post per slide | Matches what "carousel" already means in the product (FR-012's format choice) | Plan |
| Publication granularity | One `publication` row per digest per platform | Matches FR-022/US-20's own phrasing: per-*platform* success/failure, not per-story | Plan |
| Caption composition | Concatenate each selected story's `caption_summary`, truncated per platform's own limit | Reuses existing generated content verbatim — no new LLM call or cost | Plan |
| Retry policy | No automatic retry within a run; a re-trigger skips platforms that already succeeded | Matches `sendEmail()`'s existing "one attempt, fail fast" house style; prevents duplicate live posts | Plan |
| Total-failure handling | Digest stays in `approved`/`skipped` until at least one platform succeeds — no new digest state | Avoids a new transition-trigger migration; "published" keeps meaning "something went out" | Plan |
| Manual publish UI | A two-step-confirm "Publish now" panel on the existing approve page | Mirrors `ApprovalPanel`'s established precedent for one-way, consequential actions | Plan |
| Live testing | No opt-in live smoke test; one manual dry run before trusting the schedule | A real post is publicly visible on business accounts — a materially higher-stakes smoke test than a private Slides doc or a self-addressed email | Plan |

## Scope

**In scope:** `publication` schema + atomic RPC; Instagram/Facebook/LinkedIn publisher clients; publish orchestration with skip-already-succeeded retry logic; `npm run publish` worker + Tuesday 17:00 scheduler wiring; manual "Publish now" dashboard action; PRD/roadmap reconciliation; one real manual dry run.

**Out of scope:** S-09's archive/learning-loop consumption of publication results; S-10's heartbeat/alerting for a digest stuck unpublished; automatic retry/backoff within a run; a repeatable opt-in live-posting smoke test; token refresh/rotation tooling; per-platform image variants.

## Architecture / Approach

A runtime-neutral `src/lib/publishing/` package (platform clients + caption composition + the `runPublish` orchestrator) is called identically from two places: `src/worker/publish.ts` (the scheduled Tuesday fire, credentials from `.env`) and a new `/api/publish/trigger` route (the manual dashboard action, credentials from `astro:env/server`) — mirroring the existing `supabase-service.ts`/`supabase-admin.ts`/`worker/env.ts` split. The orchestrator alone decides which platforms still need publishing, so both callers always agree.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. Schema & publication record | `publication` table + atomic `record_publication` RPC | None — purely additive, no transition-trigger changes |
| 2. Platform publisher clients | Real Instagram/Facebook/LinkedIn posting code | Exact API field names may have shifted since this plan was written |
| 3. Publish orchestration | `runPublish` — the shared pending/retry/record logic | Getting "skip already-succeeded" wrong risks a duplicate live post |
| 4. Worker + scheduler wiring | `npm run publish` + Tuesday 17:00 auto-fire | Low — closely mirrors `visuals.ts`/`approval-reminder` |
| 5. Manual publish dashboard action | "Publish now" panel + API route | Low — closely mirrors `ApprovalPanel`/`useApproval` |
| 6. Docs reconciliation + live dry run | PRD/roadmap updated; real accounts verified | The only phase that touches real, publicly-visible social accounts |

**Prerequisites:** S-07 (shipped), F-05 (shipped); Meta Business/Developer app and LinkedIn API app credentials (operator confirmed these are in hand or will be by implementation time).
**Estimated effort:** ~6 phases; Phase 2 (real platform API integration) is the largest single piece of new work.

## Open Risks & Assumptions

- Meta Graph API and LinkedIn API exact request/response shapes are described from current general knowledge of each platform, not verified against live docs during planning — Phase 2 is where any drift surfaces, the same way F-03 only discovered the real Anthropic `usage` shape by implementing against it.
- Assumes the operator's Instagram account is already Business-type and linked to the Facebook Page, and the LinkedIn account is a Company Page — if not, that setup work (external, with its own possible lead time) blocks Phase 6's real dry run, not the code itself.
- LinkedIn organization-page posting generally requires the Community Management API product, an application/review process with its own external lead time — structurally the same as S-06's Canva access dependency. File the request early rather than discovering the need at Phase 6.
- A digest stuck in `approved`/`skipped` after a total publish failure has no automatic nudge in this slice (that's arguably S-10's heartbeat territory) — the operator must notice and manually retry.

## Success Criteria (Summary)

- An approved digest publishes to every selected platform without further action, at the correct scheduled time.
- A missed deadline never loses the week — the operator can always publish manually later, and a partial failure never causes a duplicate post on a platform that already succeeded.
- Every publish attempt's outcome, per platform, is visible on the dashboard.
