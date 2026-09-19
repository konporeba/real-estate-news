<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Ops Heartbeat & Catch-up (S-10)

- **Plan**: context/changes/ops-heartbeat-and-catchup/plan.md
- **Scope**: Full plan (Phases 1-5)
- **Date**: 2026-09-19
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — No timeout on sendHeartbeat's fetch call; a hung ping can block every future tick

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/heartbeat/send.ts:29
- **Detail**: `await fetchImpl(urlFor(pingUrl, outcome))` has no `AbortSignal`/timeout. Two other outbound-fetch modules in this codebase establish an explicit precedent against exactly this failure mode: `src/lib/collection/adapters/rss.ts:10` (`FETCH_TIMEOUT_MS`, comment: "One hanging feed must not stall the whole run") and `src/lib/generation/source-text.ts` (`AbortSignal.timeout(timeoutMs)`). The consequence here is worse than either precedent: `reportHeartbeat` is the last `await` in `scheduled-run.ts`'s `main()`. If the healthchecks.io ping hangs (dropped connection, no RST), `main()` never resolves and the process never exits — and since the systemd `.service` unit is a singleton by name, a hung previous invocation blocks every subsequent 15-minute timer fire, including `collection`, `approval-reminder`, and `publish`. A monitoring side-channel would then be capable of stalling the very pipeline it's supposed to be watching over — the opposite of FR-028's intent.
- **Fix**: Add a short `AbortSignal.timeout(10_000)` to the `fetchImpl` call in `send.ts`, matching the `rss.ts`/`source-text.ts` timeout pattern. A timed-out ping already returns `send_failed` via the existing catch block, so no other code path changes.
  - Strength: Directly closes the "monitoring side-channel blocks the pipeline" failure mode with a one-line change, using an already-established codebase pattern.
  - Tradeoff: None significant — 10s is generous for a simple ping and won't cause false `send_failed` results under normal network conditions.
  - Confidence: HIGH — the precedent is exact and the fix is mechanical.
  - Blind spot: None significant.
- **Decision**: FIXED — added `PING_TIMEOUT_MS = 10_000` and `AbortSignal.timeout(PING_TIMEOUT_MS)` to the `fetchImpl` call in `send.ts`; updated the affected unit tests in `send.test.ts` and `scheduled-run.test.ts` to assert the URL and signal presence via `mock.calls[0]` destructuring (matching `graph-api.test.ts`'s existing style) rather than `toHaveBeenCalledWith(..., { signal: expect.any(AbortSignal) })`, which tripped `@typescript-eslint/no-unsafe-assignment`.

### F2 — src/lib/heartbeat/ not added to the eslint runtime-boundary guard or CLAUDE.md

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: eslint.config.js (no-restricted-imports groups), CLAUDE.md (Two runtimes section)
- **Detail**: `src/lib/heartbeat/` is a new pipeline-worker-only directory (worker-side import comment at the top of `send.ts`), but `eslint.config.js`'s `no-restricted-imports` app→worker group and its reverse-direction file list were not updated to include it, and `CLAUDE.md`'s "Pipeline worker" paragraph and "App code must not import…" rule don't mention `lib/heartbeat` either. Latent today (the module only calls `fetch`, so an accidental app-side import wouldn't break the Cloudflare build), but it's a real drift from the mechanical enforcement every other worker-only lib dir gets.
- **Fix**: Add `@/lib/heartbeat/*` to both `no-restricted-imports` groups in `eslint.config.js`, and add `lib/heartbeat` to the two `CLAUDE.md` lines listing pipeline-worker-only directories.
  - Strength: Restores the mechanical guarantee the rest of the runtime-boundary rule provides, at zero behavioral cost.
- **Decision**: FIXED — added `@/lib/heartbeat/*`/`@/lib/heartbeat` to the app→worker `no-restricted-imports` group and `src/lib/heartbeat/**` to the worker→app file list in `eslint.config.js`; updated both `CLAUDE.md` lines listing pipeline-worker-only directories.

### F3 — Roadmap's cited commit range is stale

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: context/foundation/roadmap.md (S-10 entry, at-a-glance table, backlog handoff table)
- **Detail**: All three locations cite `commits \`8ac0cca\`…\`6dd13c2\`` — written during the Phase 4 commit (`bb3f49e`), so it necessarily excludes `bb3f49e` itself, Phase 5's `4831965`, and the epilogue `1c336ac`. This mirrors exactly what happened with S-09's own close-out, which was later corrected in a follow-up commit to span the full first-to-last range.
- **Fix**: Update the range in all three locations to `8ac0cca`…`1c336ac`.
  - Strength: Matches the now-established S-09 precedent for this exact situation.
- **Decision**: FIXED — updated both citations in `context/foundation/roadmap.md` to `8ac0cca`…`1c336ac`.

## Additional notes (not findings)

- Both parallel review agents independently confirmed all 5 phases' file changes MATCH their plan Contract exactly, including all 5 specific constraint checks called out for Phase 1-3 (not_configured short-circuits before any fetch call; the `/fail` URL suffix logic; `reportHeartbeat` called strictly after `runScheduledJobs` with its result never entering the returned exit-code expression; the `console.log`/`console.error` split mirroring `remind.ts`; the Phase 3 catch-up test using only synthetic, UUID-suffixed job names — never the literal `"collection"`/`"approval-reminder"`/`"publish"` strings that would claim real production rows).
- Pattern compliance: `sendHeartbeat` correctly mirrors `sendEmail`'s config-check-before-network/typed-result contract; `reportHeartbeat` correctly mirrors `notifyDigestReady`'s thin-wrapper-with-its-own-tests shape; the deviation from `graph-api.ts`'s constructed-client shape is explicitly justified in `send.ts`'s own header comment (no credential/SDK state to hold).
- Success criteria re-verified independently during this review: all 5 phases' automated checks (unit tests, typecheck, lint, full suite, build) and manual checks were confirmed passing during implementation, with no rubber-stamped items.
