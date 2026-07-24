# LLM Cost-Ceiling & Resilient-Invocation Harness Implementation Plan

## Overview

Build the shared wrapper every model call in this pipeline goes through: it enforces a hard
per-digest spend ceiling computed from token usage, constrains model output with a schema,
recovers once from a malformed response, and reports the outcome in the same discriminated-result
shape the rest of the codebase already uses.

This is roadmap foundation F-03. It unlocks S-02 (whole-pool scoring — the product's editorial
differentiator) and S-05 (Polish copy generation), and it is the first code in this project that
spends money.

## Current State Analysis

There is no LLM integration anywhere in the codebase. This slice writes all of it.

- **No SDK.** `@anthropic-ai/sdk` is not in `package.json`. It is a new dependency and must land
  worker-side only — `eslint.config.js` already forbids `src/pages/**` and `src/components/**`
  from importing worker code, and that rule must cover the new module.
- **`digest.cost_usd` exists but nothing writes it.** Declared
  `numeric(10, 4) not null default 0` at `supabase/migrations/20260722173032_digest_core_schema.sql:39`,
  surfaced in `src/db/database.types.ts:144`, and referenced exactly once in the whole repo — an
  assertion that a fresh digest starts at zero (`src/lib/digest/run-state.test.ts:97`). F-03 adds
  the first writer.
- **`run-state.ts` has no cost function.** It exports `createDigest`, `transitionDigest`,
  `markStageComplete`, `getActiveDigestForWeek`, `getLatestRecoverableDigest`, `resumeDigest`
  (`src/lib/digest/run-state.ts`). Accumulating spend is a new capability, and — unlike every
  existing run-state call — it must be atomic.
- **The worker runtime and its config pattern already exist.** `src/worker/env.ts` validates
  `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` through a zod schema and throws a message naming
  what is missing. The ceiling and API key extend that schema.
- **Migration delivery is degraded.** Port 5432 does not survive the path from the dev machine
  (TCP connects; the Postgres `SSLRequest` is never answered), so `supabase db push` cannot run.
  S-01 Phase 1 established the workaround: apply DDL through the SQL Editor **and** insert the
  `supabase_migrations.schema_migrations` row in the same script, so history stays correct.

### Key Discoveries:

- **The vendor has no budget primitive.** Resolved during F-03 research (see `change.md`): the
  Anthropic API exposes no USD-denominated cap at any level. `output_config.task_budget` looks
  like the answer but is a *token* budget the model paces itself against — documented as a
  suggestion, not a hard cap. The ceiling is therefore this slice's own arithmetic.
- **`usage` is the accounting primitive.** Every response carries `input_tokens`,
  `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. Cost is those four
  numbers against a per-model price table. Cache reads bill at ~0.1x base input; cache writes at
  1.25x (5-minute TTL).
- **Accumulation is a race.** `cost_usd = read + delta` loses increments under any concurrency,
  and S-02 scores ~234 articles. PostgREST cannot express `cost_usd = cost_usd + $1`, so this
  needs a Postgres function invoked via `rpc()` — the first RPC in the project.
- **Structured outputs mostly remove the failure FR-017 describes.** `output_config.format` with
  a `json_schema` constrains the response shape; `strict: true` guarantees tool parameters
  validate. Schema limits that matter: no recursive schemas, no numeric or string-length
  constraints, and `additionalProperties: false` is required on every object.
- **`RunStateResult` is the established error idiom.** `src/types.ts` defines
  `{ok: true, data} | {ok: false, reason, message}`, and every S-01 caller already branches on it.
  The harness mirrors that shape rather than throwing.

## Desired End State

A worker-side module that any pipeline stage calls instead of touching the SDK directly. Given a
digest and a request, it refuses the call when the digest has already reached its ceiling;
otherwise it calls Claude with a schema-constrained request, accumulates the true cost atomically
against `digest.cost_usd`, and returns either the parsed, schema-valid payload or a typed reason.
A run that starts misbehaving stops spending at a bounded point instead of billing overnight.

**Verification:** `npm test` passes with the ceiling, recovery, and accounting paths exercised
against a mock transport; an opt-in live smoke test makes one real call and confirms the `usage`
shape the accounting depends on; a test that drives spend past the ceiling proves the next call is
refused with `ceiling_reached` and `cost_usd` reflects only what was actually spent.

## What We're NOT Doing

- **Not writing any prompts.** F-03 is budget enforcement and the invocation contract. The
  geography rubric belongs to S-02, generation prompts to S-05. Each slice owns its own prompts.
- **Not implementing the Batches API.** The 50% discount matters most to S-02's whole-pool
  scoring, and batch is a different execution shape (submit → poll → collect) whose ceiling
  semantics are unclear when 234 calls are submitted as one unhaltable unit. S-02 extends the
  harness; the accounting is designed so a batch's usage can be accounted when it arrives.
- **Not transitioning the digest.** The harness returns `ceiling_reached`; the caller performs
  the `failed` transition. The harness is invoked hundreds of times per run and giving it the
  state machine would invert the layering — `collect.ts` sets the precedent that the stage owns
  its transitions.
- **Not building a model-orchestration layer.** No agent loop, no tool runner, no conversation
  management. One request in, one accounted response out.
- **Not adding observability infrastructure.** No metrics backend, no tracing. Cost lands in
  `digest.cost_usd` and errors surface through the result type.
- **Not building a per-call ledger table.** Considered and deferred — S-09's archive may want it,
  but nothing needs it yet.

## Implementation Approach

Build bottom-up, with the money-handling parts first: the atomic accounting primitive and the
price table before anything can spend, then the wrapper that uses them, then the output contract,
then the integration proof.

The controlling design decision is that **the ceiling is a check-before / accumulate-after loop
around each call, not a parameter passed into one**. Nothing in the API enforces spend, so the
harness's job is to know the running total before it commits to a call and to record the true cost
after. Enforcement granularity is therefore one call, and `max_tokens` is what bounds the overshoot
of the call already in flight — the two numbers are chosen together, not independently.

The second decision is that **the harness reports, it does not decide**. It refuses to spend and
returns a reason; whether that means failing the digest, skipping a stage, or surfacing to the
operator is the caller's judgment.

## Critical Implementation Details

**The price table encodes sticker pricing, not the introductory rate.** Sonnet 5 is $3/$15 per
million tokens at sticker, with an introductory $2/$10 running through 2026-08-31. Encoding the
intro rate would make the ceiling *looser* than reality once it lapses — the run would spend past
$5 believing it had not. Encoding sticker over-counts during the intro window, which binds the
ceiling slightly early. Over-counting is the safe direction for a spend guard, so the table uses
sticker and says why.

**`numeric(10,4)` has a precision floor.** A delta below $0.00005 rounds to zero on store, so a
sufficiently tiny call is accounted as free. At Sonnet prices a real call lands around
$0.001–$0.01, comfortably above the floor, so this is a documented limit rather than a defect —
but it must be documented, and tested, so nobody later assumes the column is exact.

**Worst-case wall clock is `timeout × (maxRetries + 1)`.** The SDK retries timeouts, so the
per-call timeout is not the bound an unattended Sunday run is exposed to — the product is. This is
the single most surprising number in the slice and belongs in a comment where the client is built.

**Prompt caching has a model-dependent minimum prefix.** 2048 tokens on Sonnet 5 (4096 on Opus
4.8). A shorter prefix silently does not cache: no error, just `cache_creation_input_tokens: 0`.
The harness therefore reports cache token counts rather than assuming caching worked, so S-02 can
verify its rubric prefix actually caches.

**Migration delivery must repeat S-01's SQL Editor pattern.** With 5432 unreachable, the Phase 1
script has to do both the DDL and its own `supabase_migrations.schema_migrations` row, or the
history drift that F-01 created and S-01 repaired comes straight back.

---

## Phase 1: Cost accounting foundation

### Overview

Land the atomic increment, the price table, and the config surface — everything needed to compute
and record a cost, before anything is able to spend one.

### Changes Required:

#### 1. Atomic cost increment

**File**: `supabase/migrations/20260724170000_digest_cost_increment.sql` (new)

**Intent**: Give the harness a way to add spend to a digest that is correct under concurrency and
returns the resulting total, so the ceiling check and the accumulation are one round trip.

**Contract**: a `security definer` function `increment_digest_cost(p_digest_id uuid, p_delta numeric)
returns numeric`, performing `update digest set cost_usd = cost_usd + p_delta where id = p_digest_id
returning cost_usd`. `search_path` pinned to `public`. Execute revoked from `public`, `anon` and
`authenticated`, granted to `service_role` only — `digest` is RLS-enabled deny-by-default and this
must not become a way around that. Returns null when the id does not exist, which the caller treats
as an error rather than a zero.

#### 2. Price table

**File**: `src/lib/llm/pricing.ts` (new)

**Intent**: Hold per-model token prices as reviewable, validated config — the multiplicand the
whole ceiling depends on.

**Contract**: a zod-validated record keyed by model ID, each entry carrying input and output USD
per million tokens, the cache-read and cache-write multipliers, and a `verified` date note
(the `sources.ts` convention). Exports `costOf(usage, model): number` computing unrounded USD from
a `usage` object across all four token fields. Sonnet 5 at sticker $3/$15; include Opus 4.8 and
Haiku 4.5 so a model change is a config edit rather than a code change.

#### 3. Worker configuration

**File**: `src/worker/env.ts`

**Intent**: Make the ceiling operator-tunable without a deploy, and fail loudly at startup if the
API key is missing rather than several stages into an unattended run.

**Contract**: extend the existing zod schema with `ANTHROPIC_API_KEY` (non-empty) and
`LLM_COST_CEILING_USD` (coerced number, positive, default 5). Both follow the existing
throw-with-named-problems pattern.

#### 4. Environment documentation

**File**: `.env.example`

**Contract**: add both new keys with the ceiling's default and a comment naming what it bounds.

### Success Criteria:

#### Automated Verification:

- `increment_digest_cost` exists and returns the post-increment total: integration test
- Two concurrent increments both land — the total equals their sum, not one of them
- `costOf` computes known usage/price pairs correctly, including cache-read and cache-write rates
- Every model the config can select has a price entry: completeness test
- Sub-$0.00005 rounding floor is asserted, documenting the column's precision limit
- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`

#### Manual Verification:

- Migration and its `schema_migrations` row applied via the SQL Editor; `select` confirms both
- Execute permission on the function is denied to `anon` and `authenticated`

**Implementation Note**: After completing this phase and all automated verification passes, pause
for manual confirmation before proceeding.

---

## Phase 2: Invocation harness

### Overview

The wrapper itself: client construction, the ceiling-checked call, cost accumulation, and the
result contract every later stage consumes.

### Changes Required:

#### 1. Dependency

**File**: `package.json`

**Contract**: add `@anthropic-ai/sdk`. Worker-side only; the lint boundary keeps it out of the
Astro bundle.

#### 2. Runtime-neutral client

**File**: `src/lib/llm/client.ts` (new)

**Intent**: Construct the SDK client without reading any environment of its own, mirroring
`src/lib/supabase-service.ts` so the module resolves in the worker and in Vitest alike.

**Contract**: `createLlmClient(apiKey, options?)` returning the SDK client, cached per key as
`supabase-service.ts` caches. Sets an explicit `timeout` (milliseconds — the TypeScript SDK's unit,
unlike Python's seconds) and leaves `maxRetries` at its default of 2. A header comment records that
worst-case wall clock per call is `timeout × (maxRetries + 1)`.

#### 3. Result contract

**File**: `src/types.ts`

**Intent**: Give the harness the same discriminated-result idiom callers already handle.

**Contract**: `LlmErrorReason` = `ceiling_reached` | `malformed_output` | `refusal` |
`truncated` | `context_exceeded` | `api_error` | `not_configured`, plus `LlmResult<T>` mirroring
`RunStateResult<T>`. Each reason documented with the condition that produces it.

#### 4. The harness

**File**: `src/lib/llm/invoke.ts` (new)

**Intent**: The single entry point every pipeline stage calls instead of the SDK.

**Contract**: takes a Supabase client, a digest id, and a request (messages, system, model,
`max_tokens`, optional schema, optional cache breakpoints), and (a) reads the digest's current
`cost_usd` and refuses with `ceiling_reached` when it is already at or above the ceiling;
(b) issues the call; (c) computes cost from `response.usage` via `costOf`; (d) accumulates it
through `increment_digest_cost` — **accounting happens even when the response is unusable**, since
a refusal or a truncated response still bills; (e) branches on `stop_reason` before reading
`content`; (f) returns the payload or a typed reason. Cache-token counts from `usage` are returned
alongside so callers can verify caching actually engaged.

#### 5. Mock transport

**File**: `src/lib/llm/testing.ts` (new)

**Intent**: Make ceiling, accounting, and recovery deterministically testable without spending.

**Contract**: a factory producing a client-shaped stub whose `messages.create` returns queued
canned responses (or throws queued errors), recording the requests it received. Response fixtures
carry realistic `usage` objects, since the accounting is what is under test.

### Success Criteria:

#### Automated Verification:

- A call below the ceiling succeeds and increases `cost_usd` by the computed amount
- A digest already at the ceiling is refused with `ceiling_reached` and makes no API call
- Cost is accounted even when the response is a refusal or is truncated
- Concurrent calls against one digest accumulate correctly (no lost increments)
- Cache token counts from `usage` are surfaced in the result
- A missing API key surfaces as `not_configured` rather than an SDK throw
- Type checking, linting and the full suite pass

#### Manual Verification:

- The harness imports and runs under plain Node with no Astro build

**Implementation Note**: After completing this phase and all automated verification passes, pause
for manual confirmation before proceeding.

---

## Phase 3: Structured outputs & recovery

### Overview

Make the output contract enforceable, and add the one recovery stage that earns its place.

### Changes Required:

#### 1. Schema-constrained requests

**File**: `src/lib/llm/invoke.ts`

**Intent**: Prevent malformed output rather than repairing it.

**Contract**: when the caller supplies a zod schema, convert it to JSON Schema, send it as
`output_config.format`, and parse the response back through the zod schema before returning. The
converter must reject schema shapes the API does not support (recursive schemas, numeric and
string-length constraints) at call time with a clear message, rather than letting the API 400 mid-run.

#### 2. Single-reprompt recovery

**File**: `src/lib/llm/invoke.ts`

**Intent**: Satisfy FR-017's staged recovery with two stages that both earn their place — constrain,
then one corrective retry.

**Contract**: on a validation failure, retry once with the validation error appended as a user turn
naming what was wrong; a second failure returns `malformed_output` carrying both attempts' errors.
The retry is a normal call and is therefore ceiling-checked and accounted like any other — a run at
its limit does not get a free retry.

#### 3. Stop-reason taxonomy

**File**: `src/lib/llm/invoke.ts`

**Intent**: Branch on `stop_reason` before touching `content`, because a refusal returns HTTP 200
with possibly-empty content and naive indexing crashes.

**Contract**: map `refusal` → `refusal` (carrying `stop_details.category` when present, guarding
that `stop_details` may be null), `max_tokens` → `truncated`,
`model_context_window_exceeded` → `context_exceeded`, `pause_turn` → `api_error` with a message
naming it as unsupported (no server-side tools are used in this slice). `end_turn` is the only path
that reads content.

### Success Criteria:

#### Automated Verification:

- A schema-valid response parses and returns typed data
- One malformed response then a valid one: the retry succeeds and both calls are accounted
- Two malformed responses return `malformed_output` with both errors
- A retry is refused when the first call exhausted the ceiling
- Each `stop_reason` maps to its documented reason; a refusal with empty content does not throw
- An unsupported schema shape is rejected before any API call
- Type checking, linting and the full suite pass

#### Manual Verification:

- The error message for an unsupported schema names the offending constraint clearly enough to fix

**Implementation Note**: After completing this phase and all automated verification passes, pause
for manual confirmation before proceeding.

---

## Phase 4: Integration & verification

### Overview

Prove it works against the real API, keep it on the correct side of the runtime boundary, and
document it.

### Changes Required:

#### 1. Live smoke test

**File**: `src/lib/llm/invoke.live.test.ts` (new)

**Intent**: Catch SDK or API drift that fixtures cannot see — the failure class the S-01 live smoke
test caught within minutes of existing.

**Contract**: gated on `LLM_LIVE_SMOKE=1` (mirroring `COLLECTION_LIVE_SMOKE`), makes one small
schema-constrained real call against a throwaway digest, and asserts the `usage` object carries all
four token fields the accounting reads and that `cost_usd` moved by a plausible amount. Skips by
default so CI stays hermetic and free.

#### 2. Runtime boundary

**File**: `eslint.config.js`

**Contract**: extend the existing worker-side group to cover `src/lib/llm/**`, so the new module
inherits both directions of the boundary — it may not import `astro:env/server`, and pages and
components may not import it.

#### 3. End-to-end ceiling proof

**File**: `src/lib/llm/invoke.test.ts`

**Intent**: Demonstrate the NFR, not just its parts — repeated malformed output cannot outspend the
ceiling.

**Contract**: an integration test driving a loop of failing calls against a real digest with a low
ceiling, asserting the loop halts, `cost_usd` never exceeds the ceiling by more than one call's
worst case, and the final result is `ceiling_reached`.

#### 4. Documentation

**File**: `CLAUDE.md`

**Contract**: document the harness as the required path for model calls, the two env vars, the live
smoke command, and the rule that no stage calls the SDK directly.

### Success Criteria:

#### Automated Verification:

- Live smoke passes with its flag set and skips without it
- The boundary rule rejects a deliberate `astro:env/server` import from `src/lib/llm/`, and a
  page importing `@/lib/llm/invoke` (revert both after verifying)
- The end-to-end ceiling test halts and stays within one call's worst case of the limit
- Full suite, type check, lint and build pass

#### Manual Verification:

- A real run's `cost_usd` is plausible against the token counts the smoke test reported
- The CLAUDE.md entry is enough for the next slice to use the harness without reading its source

**Implementation Note**: After completing this phase and all automated verification passes, pause
for final manual confirmation.

---

## Testing Strategy

### Unit Tests:

- `costOf` arithmetic across all four token fields, including cache multipliers
- Price-table completeness and the rounding floor
- Schema conversion, including rejection of unsupported shapes
- `stop_reason` mapping, especially a refusal with empty content

### Integration Tests (against the configured Supabase project, opt-in):

- Atomic increment under concurrency
- Ceiling refusal, accounting-on-failure, and the end-to-end halt proof

> `.env` sets `SUPABASE_TEST_PROJECT=1` and `vitest.config.ts:25` loads it, so these run on a plain
> `npm test` here. The flag still matters in CI, which has no `.env`.

### Live Smoke (opt-in, excluded from CI):

- One real schema-constrained call verifying the `usage` shape the accounting depends on

### Manual Testing Steps:

1. Apply the Phase 1 SQL and confirm both the function and its history row
2. Run the live smoke and compare reported tokens against the recorded `cost_usd`
3. Set `LLM_COST_CEILING_USD` very low and confirm the next call is refused

## Performance Considerations

Every call costs one extra round trip to read the current total before spending. That is one
PostgREST read against a millisecond-scale database versus a call that takes seconds and costs
money — not a hot path worth optimizing, and the alternative (caching the total in the worker)
reintroduces the lost-update race Phase 1 exists to remove.

## Migration Notes

This slice adds the project's third migration and its first Postgres function. Delivery goes
through the SQL Editor while 5432 is unreachable, including the `schema_migrations` row — see
`context/archive/2026-07-24-weekly-source-collection/plan.md` Phase 1 for the pattern and the
reason. Regenerate types afterwards with
`npx supabase gen types typescript --project-id <ref>`, and re-add the `GENERATED FILE` header the
generator drops.

## References

- Resolved research and the F-03 decision record: `context/changes/llm-cost-ceiling-harness/change.md`
- Roadmap item: `context/foundation/roadmap.md` (F-03)
- Result-type precedent: `src/types.ts`, `src/lib/digest/run-state.ts`
- Runtime-neutral client precedent: `src/lib/supabase-service.ts`
- Code-shaped config precedent: `src/lib/collection/sources.ts`
- Live-smoke and SQL-Editor-delivery precedent: `context/archive/2026-07-24-weekly-source-collection/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Cost accounting foundation

#### Automated

- [ ] 1.1 `increment_digest_cost` exists and returns the post-increment total
- [ ] 1.2 Two concurrent increments both land — total equals their sum
- [ ] 1.3 `costOf` computes known usage/price pairs, including cache rates
- [ ] 1.4 Every selectable model has a price entry: completeness test
- [ ] 1.5 Sub-$0.00005 rounding floor asserted and documented
- [ ] 1.6 Type checking passes: `npx astro check`
- [ ] 1.7 Linting passes: `npm run lint`

#### Manual

- [ ] 1.8 Migration and its `schema_migrations` row applied and confirmed
- [ ] 1.9 Execute permission denied to `anon` and `authenticated`

### Phase 2: Invocation harness

#### Automated

- [ ] 2.1 A call below the ceiling succeeds and increases `cost_usd` correctly
- [ ] 2.2 A digest at the ceiling is refused with `ceiling_reached`, no API call made
- [ ] 2.3 Cost is accounted even when the response is a refusal or truncated
- [ ] 2.4 Concurrent calls against one digest accumulate with no lost increments
- [ ] 2.5 Cache token counts are surfaced in the result
- [ ] 2.6 Missing API key surfaces as `not_configured`
- [ ] 2.7 Type checking, linting and full suite pass

#### Manual

- [ ] 2.8 The harness imports and runs under plain Node with no Astro build

### Phase 3: Structured outputs & recovery

#### Automated

- [ ] 3.1 A schema-valid response parses and returns typed data
- [ ] 3.2 One malformed then valid: retry succeeds, both calls accounted
- [ ] 3.3 Two malformed responses return `malformed_output` with both errors
- [ ] 3.4 A retry is refused when the first call exhausted the ceiling
- [ ] 3.5 Each `stop_reason` maps correctly; refusal with empty content does not throw
- [ ] 3.6 An unsupported schema shape is rejected before any API call
- [ ] 3.7 Type checking, linting and full suite pass

#### Manual

- [ ] 3.8 Unsupported-schema error names the offending constraint clearly

### Phase 4: Integration & verification

#### Automated

- [ ] 4.1 Live smoke passes with its flag and skips without it
- [ ] 4.2 Boundary rules reject a deliberate cross-runtime import in both directions
- [ ] 4.3 End-to-end ceiling test halts within one call's worst case of the limit
- [ ] 4.4 Full suite, type check, lint and build pass

#### Manual

- [ ] 4.5 A real run's `cost_usd` is plausible against reported token counts
- [ ] 4.6 CLAUDE.md entry is sufficient to use the harness without reading its source
