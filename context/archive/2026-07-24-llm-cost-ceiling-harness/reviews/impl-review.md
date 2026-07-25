<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: LLM Cost-Ceiling & Resilient-Invocation Harness

- **Plan**: context/changes/llm-cost-ceiling-harness/plan.md
- **Scope**: All 4 phases (full plan)
- **Date**: 2026-07-25
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated success criteria re-run at review time: `npx astro check` 0 errors, `npm run lint` clean,
`npm test` 138 passing / 10 skipped, build green. All planned files present, none unplanned. The
three points flagged to the review checked out: the hand-added `increment_digest_cost` type matches
the migration (`Args {p_digest_id: string, p_delta: number}`, `Returns: number | null`); the
caller-owns-transition boundary is sound and documented; sticker-vs-intro pricing is deliberate and
explained.

## Findings

### F1 — Ceiling overshoot scales with concurrency, but is documented as "soft by one call"

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/llm/invoke.ts:123-146 (check at 130, increment at 143); claim at invoke.ts:6-7 and invoke.test.ts:206
- **Detail**: `attemptCall` reads `cost_usd`, checks it against the ceiling, `await`s the API
  call, then increments — three round trips with the network call in between. The check and the
  increment are not atomic. For SEQUENTIAL calls the overshoot is bounded by one call, as claimed.
  But under CONCURRENCY — precisely S-02's pattern (the plan's Q4 justified the atomic RPC by
  "S-02 scores ~234 articles" concurrently) — N in-flight calls can all read the same
  pre-increment total, all pass the check, and all spend. The real overshoot bound is
  `concurrency × max per-call cost`, not one call. The atomic RPC makes the *accounting* correct
  (no lost increments — tested), but it does not make the *ceiling* hold under concurrency. The
  end-to-end test (invoke.test.ts:185) only exercises the sequential loop, so the gap is untested
  and the comment "soft by exactly one in-flight call" is inaccurate for the documented use case.
  Practical overshoot is small — at Sonnet prices (~$0.001–$0.01/call) even 10 concurrent calls
  overshoot a $5 ceiling by cents — but a future reader (S-02's author) may rely on the stated
  one-call bound and be surprised, more so with a pricier model or higher concurrency.
- **Fix**: Document the true bound rather than adding a reservation mechanism the plan deliberately
  avoided. Update the invoke.ts header comment and the invoke.test.ts comment to state that the
  ceiling is soft by up to `concurrency × per-call cost`, that `max_tokens` × bounded concurrency
  is what keeps it small, and that S-02 should cap its scoring concurrency accordingly. Optionally
  add a concurrent-overshoot test asserting the bound scales as expected (documents the behavior
  rather than pretending it doesn't exist).
  - Strength: Matches the plan's explicit "soft ceiling, one-call granularity" design decision
    (Q on preflight chose "check remaining budget, bound overshoot with max_tokens" over a
    reservation), so this corrects the docs to reality instead of re-litigating the design.
  - Tradeoff: The ceiling remains genuinely soft under concurrency — accepted, since the practical
    overshoot is cents and S-02 controls its own concurrency.
  - Confidence: HIGH — the non-atomicity is visible in the three-round-trip sequence and confirmed
    by reasoning; the small practical impact follows from the verified per-call cost (~$0.0008 live).
  - Blind spot: Haven't measured what concurrency S-02 will actually use; if it fires all 234 at
    once against a pricier model the overshoot could reach dollars, which the doc note should call out.
- **Decision**: FIXED — corrected the invoke.ts header comment and the invoke.test.ts comments to
  state the true bound (`concurrency × per-call cost`), that the ceiling is soft not atomic, and
  that a caller scoring a large pool (S-02) should cap fan-out. Docs-only; 8 invoke tests green.

### F2 — A billed call whose accounting fails loses that call's cost on re-trigger

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/lib/llm/invoke.ts:143-152
- **Detail**: If `increment_digest_cost` fails after a successful (billed) call, the money was
  spent but `cost_usd` was not updated; `invoke` returns `api_error`. The caller typically fails
  the digest, and a re-trigger re-runs the whole stage, re-spending — the lost call's cost is never
  recorded, so `cost_usd` understates true spend across the failure. This is the documented
  behavior ("fail loudly rather than continue against a total that understates real spend") and the
  trigger (RPC failure) is rare, so it is working as designed. Noted for the record only — a future
  hardening could persist a pending-cost marker before the call, but that is out of scope here.
- **Fix**: None needed — accept as designed. If it ever bites, record intended cost before the call
  and reconcile after.
- **Decision**: FIXED (5771bbd) — hardened on request, but NOT via the reserve-before-marker in the
  option text (that reintroduces the reserve-and-refund the plan rejected: leak-on-crash,
  temporarily-untrue `cost_usd`). Instead `accountCost` retries the increment with bounded backoff,
  since the real failure mode is a transient DB write and the cost is already known; a missing
  digest bails at once, persistent failure still fails loudly. Four unit tests
  (`accounting.test.ts`) cover the branches.
