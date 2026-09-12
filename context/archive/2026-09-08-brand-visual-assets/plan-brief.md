# Brand Visual Assets (S-06) — Plan Brief

> Full plan: `context/changes/brand-visual-assets/plan.md`
> Template spec (written in Phase 2): `context/changes/brand-visual-assets/template-spec.md`

## What & Why

Roadmap slice S-06 (FR-015, US-13, US-14): the operator's selected stories already get Polish
social copy, but nothing visual. This slice turns each generated story into a branded square PNG by
filling named text boxes in Google Slides decks the operator owns and designs. It is the last
prerequisite blocking S-07's approval gate, and therefore the whole publish loop.

The point of FR-015 is not "make images" — it is that the operator controls the design directly,
without a code change or a deploy.

## Starting Point

`generated_copy` was built for this: it already stores `polish_title`, `caption_summary`,
`body_copy` and `key_statistics` per selected story, and its own table comment names S-06 as the
consumer. What does not exist: any `generated_asset` table, any binary storage, any Google
credentials, and any pipeline state between `generating` and `ready_for_approval` — generation
transitions straight through today.

## Desired End State

`npm run visuals` takes a digest left in `rendering`, produces one PNG per slide into a private
Supabase Storage bucket, and moves the digest to `ready_for_approval`. The operator opens the
digest page and sees the cards. Changing a colour in the Slides deck changes next week's output,
with nothing rebuilt or redeployed.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Rendering backend | Google Slides API, native design | Canva Autofill requires Enterprise membership — verified by the operator against their own Pro account — and Slides is free, needs no access application, and satisfies US-13 literally |
| Google auth | Service account, decks shared as Editor | No consent screen and no refresh token means nothing can silently expire between weekly unattended runs; an OAuth client left in "Testing" would die every 7 days |
| Drive file creation | None, ever | Service accounts have no consumer Drive quota, so the worker duplicates and deletes pages *inside* the operator's decks instead of copying files |
| Image storage | Private Supabase Storage bucket | `getThumbnail` URLs live 30 minutes; FR-024 wants a permanent archive, and both runtimes can reach Supabase regardless of where the app is deployed |
| Pipeline placement | New `rendering` state + `npm run visuals` | Directly applies S-05's carried-forward lesson: a free render failure must not force re-paying dollar-sized copy generation |
| Failure posture | Retry once per story, then fail the stage | Absorbs transient blips like `generateStory` and `clusterArticles` already do, while never letting a half-visual post reach the approval gate |
| Template matrix | One square 1080×1080 deck per format | Square renders correctly on all three platforms and halves the operator's design work; per-platform templates stay a cheap later migration |
| Carousel length | Cover + one slide per story | Length follows content, so no filler slides and no silently dropped story (closes roadmap OQ#3) |
| Card content | Title + first 3 statistics | The image stops the scroll and the caption carries the substance; three fixed slots because Slides cannot hide an empty element |
| Text fitting | Computed font size + length gate | Slides autofit is reset to `NONE` by any API text edit, so the worker must size the title itself — deterministic and unit-testable, like the numeric gate |
| Deck bootstrap | Written spec + `visuals:validate` | A mistyped placeholder becomes a setup-time error instead of a card with `{{TITLE}}` printed on it |
| Preview scope | Read-only strip on the digest page | US-13 and US-14 are only verifiable by looking; approve/reject controls remain S-07's |

## Scope

**In scope:** the `rendering` state and its migrations; `generated_asset` and a private storage
bucket; a Slides client and deck validator; slot mapping and text fitting; the render orchestrator
and `npm run visuals`; a read-only dashboard preview; an opt-in live smoke test and a
operator-verified real run.

**Out of scope:** Canva in any form; per-platform templates; image post-processing or resizing;
approve/reject controls (S-07); publishing (S-08); scheduler wiring; any change to S-05's prompt.

## Architecture / Approach

```
generating ──▶ rendering ──▶ ready_for_approval
                  │  ▲
                  ▼  └── failed (retry in place)
        npm run visuals
                  │
    generated_copy ──▶ slot map + fitted font size
                  │
      Slides deck: duplicate page → style → replaceAllText → getThumbnail → delete page
                  │
      download PNG ──▶ Supabase Storage ──▶ generated_asset ──▶ dashboard preview
```

The worker treats the operator's deck as long-lived mutable state shared with a human: pages are
duplicated with a recognisable id prefix, cleaned up in a `finally`, and any leftovers from a
crashed run are swept on the next start.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema, state, storage | `rendering` state, `generated_asset`, private bucket | Enum value must ship in its own migration or the transaction fails |
| 2. Client, spec, validator | Slides transport, deck spec, `visuals:validate` | Service-account key handling — dotenv has bitten this project before |
| 3. Slots & fitting | Pure slot map + font-size step-down | Tier table is a heuristic until calibrated on real titles |
| 4. Orchestrator | The stage end to end, against fakes | Deck cleanup must survive every failure path |
| 5. Entrypoint | `npm run visuals`; generation now hands off to `rendering` | Touching a shipped, reviewed stage |
| 6. Preview | Read-only card strip on the digest page | Storage errors must not render as an empty state (S-03 F2) |
| 7. Live verification | Smoke test + operator-confirmed real run | First contact with the real Google account and real decks |

**Prerequisites:** a Google Cloud project with the Slides API enabled and a service account key;
two Slides decks built by the operator to the Phase 2 spec and shared with the service account as
Editor; a digest that has reached `generating` with confirmed picks.

**Estimated effort:** ~3-4 sessions across 7 phases, plus the operator's deck design work, which
gates phases 4 onward.

## Open Risks & Assumptions

- The font-size tier table is a heuristic. It is calibrated in Phase 7 against titles that actually
  occurred; until then a long Polish headline could fail a run.
- The decks are shared mutable state. Sweep-and-cleanup handles a crashed run, but a human editing
  a deck at the moment the worker runs is unhandled — acceptable for a single operator running a
  weekly command, and worth revisiting if this stage is ever scheduled.
- Slides exports at 1600px, not 1080px. Stored as-is; platforms downscale server-side. If quality
  disappoints, a resizing dependency becomes a follow-up.
- One square template serves all three platforms, so US-14 is satisfied degenerately today. The
  schema deliberately omits a `platform` column; adding one later is cheap.
- The `supabase migration repair` debt inherited from F-01 and S-05 stands at six migrations and
  grows to eight here unless Phase 1 clears it.

## Success Criteria (Summary)

- The operator runs `npm run visuals` and gets publishable branded cards for every selected story.
- The operator changes a colour in a Slides deck, re-runs, and sees the change — no code, no deploy.
- A render failure is recoverable by re-running the render alone, never by re-paying generation.
