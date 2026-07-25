# LLM Cost-Ceiling & Resilient-Invocation Harness — Plan Brief

> Full plan: `context/changes/llm-cost-ceiling-harness/plan.md`
> Decision record & research: `context/changes/llm-cost-ceiling-harness/change.md`

## What & Why

Every model call in this pipeline goes through one wrapper that enforces a hard $5-per-digest
spend ceiling, constrains output with a schema, and reports outcomes in the codebase's existing
result idiom. The motivating requirement (FR-016, NFR "Bounded cost per run") is that an
unattended weekly run — one nobody is watching on a Sunday — cannot bill quietly overnight, even
under repeated malformed model output.

## Starting Point

There is no LLM integration in the codebase at all. `digest.cost_usd numeric(10,4)` exists from
F-01 but nothing writes it — it is referenced once, in a test asserting a fresh digest starts at
zero. `run-state.ts` has no cost function, and `@anthropic-ai/sdk` is not installed. This slice
writes all of it, including the project's first Postgres function.

## Desired End State

Any pipeline stage calls `invoke()` instead of the SDK. It refuses when the digest has already hit
its ceiling, otherwise calls Claude with a schema-constrained request, accumulates the true cost
atomically, and returns either typed data or a typed reason. A misbehaving run stops spending at a
bounded point instead of running up a bill.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Budget primitive | None exists — build it | The Anthropic API has no USD cap at any level; `task_budget` is a token suggestion, not a hard cap | Research |
| Model | Sonnet 5 everywhere | Near-Opus quality on coding/agentic work at ~40% less; puts an estimated week near $1.20–$2.00 | Plan |
| Ceiling | $5 per digest run | ~2.5–4x a normal Sonnet week — catches a runaway without failing legitimate weeks | Plan |
| Halt behavior | Fail digest with diagnostic | Exactly what US-15 specifies; `failed → collecting` already exists in the state machine | Plan |
| Accumulation | Postgres RPC, atomic | `cost_usd = read + delta` loses increments; S-02 scores ~234 articles concurrently | Plan |
| FR-017 recovery | Schema + one reprompt | Structured outputs mostly prevent malformation; a four-rung ladder guards a rare case | Plan |
| Ceiling check | Before call, `max_tokens` bounds overshoot | One round trip; overshoot is a number you set rather than unbounded | Plan |
| Batch API | Deferred to S-02 | Different execution shape; ceiling semantics unclear for an unhaltable 234-call unit | Plan |
| Prompt caching | Supported now | Per-call concern that belongs in the wrapper; awkward to retrofit | Plan |
| Config | Ceiling in env, model + prices in code | Mirrors `sources.ts`; prices are reviewable facts, the ceiling is an emergency knob | Plan |
| Contract | Discriminated result | Matches `RunStateResult`; a missed `catch` in an unattended worker kills the run | Plan |
| Transition on halt | Caller's job, not the harness's | The harness runs hundreds of times per run; owning the state machine would invert layering | Plan |

## Scope

**In scope:** atomic cost accounting (RPC + price table), the ceiling-checked invocation wrapper,
structured outputs with one-reprompt recovery, `stop_reason` taxonomy, prompt-cache passthrough
and reporting, mock transport, opt-in live smoke, runtime-boundary enforcement.

**Out of scope:** any prompts (S-02/S-05 own theirs), the Batches API, digest state transitions,
agent loops or tool running, metrics/tracing infrastructure, a per-call ledger table.

## Architecture / Approach

The ceiling is a **check-before / accumulate-after loop around each call**, not a parameter passed
into one — nothing in the API enforces spend, so the harness must know the running total before
committing and record the true cost after. Enforcement granularity is one call; `max_tokens` bounds
the overshoot of the call in flight.

```
caller → invoke(client, digestId, request)
           ├─ read cost_usd ── at ceiling? → { ok: false, ceiling_reached }
           ├─ SDK call (schema-constrained, cache breakpoints)
           ├─ costOf(usage, model) → increment_digest_cost() [atomic]   ← runs even on failure
           └─ branch stop_reason → typed data | typed reason
```

The harness reports; it does not decide. Whether `ceiling_reached` means failing the digest is the
caller's judgment.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Cost accounting foundation | Atomic increment RPC, price table, env config | Migration delivery — 5432 is unreachable, so it goes via SQL Editor including its history row |
| 2. Invocation harness | SDK client, ceiling-checked `invoke()`, result contract, mock transport | Getting accounting right on failure paths (a refusal still bills) |
| 3. Structured outputs & recovery | Schema constraint, one reprompt, `stop_reason` taxonomy | Schema shapes the API rejects (recursive, numeric ranges) must fail at call time, not mid-run |
| 4. Integration & verification | Live smoke, boundary rules, end-to-end ceiling proof, docs | Live smoke is the only thing holding mocks honest against real SDK shapes |

**Prerequisites:** none — F-03 has no roadmap dependencies. Needs an `ANTHROPIC_API_KEY` and SQL
Editor access for Phase 1.
**Estimated effort:** ~3–4 sessions across four phases; Phase 1 is gated on the manual SQL step.

## Open Risks & Assumptions

- **The $5 ceiling rests on a token estimate, not observation.** No real scoring run has happened.
  If a week legitimately costs more, the ceiling fails the digest — recoverable via re-trigger, but
  it costs the week. Revisit after S-02's first real run.
- **Sonnet 5's introductory pricing lapses 2026-08-31.** The price table encodes *sticker* rates
  deliberately: encoding the intro rate would make the ceiling looser than reality once it ends.
  Over-counting is the safe direction, but it means the ceiling binds slightly early until then.
- **`numeric(10,4)` rounds sub-$0.00005 calls to zero.** Documented and tested rather than solved;
  real Sonnet calls sit well above the floor.
- **Re-triggering a ceiling-halted digest restarts from `collecting`.** The state machine only
  allows `failed → collecting`, so a ranking-stage halt re-runs collection. Cheap and de-duplicating,
  but wasted work.
- **Mocks can drift from real SDK response shapes.** Only the opt-in live smoke catches that.

## Success Criteria (Summary)

- A run that repeatedly gets malformed output halts at the ceiling instead of billing on, and the
  operator sees why in `last_error`.
- `digest.cost_usd` reflects what a run actually spent, including calls whose responses were unusable.
- S-02 can score a 234-article pool through one function without touching the SDK, and can verify
  its rubric prefix is actually caching.
