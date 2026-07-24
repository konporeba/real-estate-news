---
change_id: llm-cost-ceiling-harness
roadmap_id: F-03
title: LLM cost-ceiling & resilient-invocation harness
status: new
created: 2026-07-24
updated: 2026-07-24
prd_refs: [FR-016, FR-017, US-15]
roadmap: context/foundation/roadmap.md
archived_at: null
---

# F-03: LLM cost-ceiling & resilient-invocation harness

A shared wrapper around every model call that enforces a hard per-run cost ceiling and halts
on reaching it, with staged malformed-output recovery and bounded backoff retries — so an
unattended run can never bill quietly overnight.

Unlocks S-02 (whole-pool scoring calls) and S-05 (generation calls). Reduces the bounded-cost
NFR risk on every LLM stage. No prerequisites; buildable now.

Minimal scope: budget enforcement + the retry/recovery contract. Not a general
model-orchestration layer — each slice still owns its own prompts.

## Notes

**Resolved unknown (roadmap F-03) — 2026-07-24. The premise was wrong.**

The question was "which model SDK/provider exposes the budget primitive (`maxBudgetUsd` /
`maxCost`)". Answer: **none does.** The Anthropic API has no USD-denominated budget parameter
at any level. FR-016's "hard per-run cost ceiling" therefore cannot be delegated to the SDK —
it has to be **computed application-side** from token usage and a per-model price table, which
makes the ceiling this slice's own responsibility rather than a thin wrapper over a vendor
feature. That is a larger slice than the roadmap assumed, but it is also why F-03 exists.

What the API *does* expose, and what each is actually good for:

| Primitive | What it is | Use for FR-016/017 |
| --- | --- | --- |
| `usage` on every response | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | **The accounting primitive.** Accumulate × price table → `digest.cost_usd`. |
| `max_tokens` | Hard per-**response** output cap, enforced; the model is unaware of it | Bounds a single call. Hitting it yields `stop_reason: "max_tokens"` and truncated output. |
| `output_config.task_budget` (beta `task-budgets-2026-03-13`) | A **token** budget for an agentic loop that the model sees and paces itself against. Min 20,000. | Explicitly *"a suggestion the model is aware of, not a hard cap"* — graceful wind-down, **not** an enforcement mechanism. Do not use it as the ceiling. |
| `output_config.effort` | `low`/`medium`/`high`/`xhigh`/`max` — thinking depth and overall token spend | Cost dial, not a limit. |
| `count_tokens` endpoint | Pre-flight, model-specific token count | Estimate a call's input cost *before* spending it — lets the ceiling reject a call rather than discover the overspend afterwards. Never use `tiktoken`; it undercounts Claude by 15–20%. |

**Consequence for the harness contract:** the ceiling is a check-before / accumulate-after loop
around each call, not a parameter passed into it. Halting means the wrapper refuses the next
call, so the granularity of enforcement is one call — `max_tokens` is what bounds the overshoot
of the call already in flight. Both numbers need to be chosen together.

**FR-017 (malformed output) is mostly designed away, not retried.** Structured outputs
(`output_config.format` with a `json_schema`) constrain the response shape, and `strict: true`
on a tool guarantees its parameters validate. Schema caveats: no recursive schemas, no numeric
or string length constraints, `additionalProperties: false` required on every object. A new
schema pays a one-time compile cost, then caches 24h. So "staged recovery" should be a narrow
fallback, not the primary path. Retry/backoff for transport failures is already in the SDK:
`maxRetries` defaults to 2 and covers 408/409/429/5xx plus connection errors.

**Stop reasons the wrapper must branch on** before reading `content`: `max_tokens`,
`refusal` (a successful 200 with possibly-empty content — reading `content[0]` unconditionally
crashes), `model_context_window_exceeded`, and `pause_turn` for server-side tools.

**TypeScript footgun:** in `@anthropic-ai/sdk` the client `timeout` is in **milliseconds**
(Python/Ruby use seconds). Timeouts are retried, so worst-case wall clock is
`timeout × (maxRetries + 1)` — that product, not the timeout alone, is what an unattended
Sunday run is exposed to.

**What already exists to build against.** F-01 shipped `digest.cost_usd`
(`numeric(10,4) not null default 0`) — the per-run accumulator the ceiling reads and writes.
The harness needs no new schema unless it wants per-call granularity.

**Runtime.** This runs in the pipeline worker (plain Node), not the Astro/workerd app. See
CLAUDE.md "Two runtimes" — worker code must not import `astro:env/server` or
`@/lib/supabase-admin`, and the lint rules enforce it. Config comes from `src/worker/env.ts`.

**Why it precedes S-02.** The first LLM call is S-02 scoring over the whole article pool —
234 articles on the first real collection run. That is exactly the unattended failure mode
this guards, which is why the harness lands first.

**Two cost levers S-02 should inherit from this slice** (both found during the F-03 research;
neither is in the roadmap):

1. **Message Batches API — 50% off.** Scoring a whole week's pool is asynchronous,
   non-latency-sensitive work: the digest sits in `ranking` for hours or days before the
   operator opens it. That is precisely the batch use case. Up to 100k requests per batch,
   most complete within an hour, results keyed by `custom_id` (they arrive in **any** order).
   Halving the cost of the single most expensive stage is worth designing the harness to
   support batch submission, not just single calls.
2. **Prompt caching for the rubric.** Every scoring call shares the same rubric prompt, so it
   is a stable cacheable prefix — cache reads cost ~0.1× base input. **Watch the minimum
   cacheable prefix**, which is model-dependent: 4096 tokens on Opus 4.8 but 2048 on Sonnet 5.
   A rubric shorter than the threshold silently does not cache — no error, just
   `cache_creation_input_tokens: 0`. Verify with `usage.cache_read_input_tokens`, and note
   caching is a **prefix match**: any per-article text must come *after* the breakpoint.

**Model choice is an open decision, not a research finding.** Prices as of 2026-07-24, per
million tokens (input/output): Opus 4.8 $5/$25, Sonnet 5 $3/$15 (intro $2/$10 through
2026-08-31), Haiku 4.5 $1/$5. The price table the ceiling multiplies by has to live somewhere
and go stale — it needs an owner and a review cadence.
