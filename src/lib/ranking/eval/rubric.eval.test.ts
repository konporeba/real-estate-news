// The eval GATE: runs the held-out labeled set through the REAL rubric scorer and asserts geography
// tier + pairwise ordering. This is the regression gate for FR-026/US-25 — run it before shipping
// any rubric change.
//
// Opt-in via RANKING_EVAL=1 (+ the usual Supabase test env + ANTHROPIC_API_KEY), mirroring
// LLM_LIVE_SMOKE: it makes real paid scoring calls, so CI stays hermetic and a routine `npm test`
// never spends money.
//
//   RANKING_EVAL=1 SUPABASE_TEST_PROJECT=1 npx vitest run src/lib/ranking/eval/rubric.eval.test.ts
//
// Phase 1 note: the real scorer arrives in Phase 2 (src/lib/ranking/score-clusters.ts → a singleton
// scorer). Until then this suite is wired to the interface and skipped by the env gate; Phase 2
// swaps in the real scorer and the gate goes live.
import { describe, expect, it } from "vitest";

import { EVAL_EXAMPLES, EXPECTED_ORDERINGS } from "@/lib/ranking/eval/examples";
import { evaluateRubric, formatReport, type Scorer } from "@/lib/ranking/eval/harness";

const live = Boolean(
  process.env.RANKING_EVAL === "1" &&
  process.env.SUPABASE_TEST_PROJECT === "1" &&
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  process.env.ANTHROPIC_API_KEY,
);

// Phase 2 replaces this with the real rubric scorer (a singleton-cluster wrapper around
// scoreClusters). Kept as a throwing stub so a misconfigured live run fails loudly rather than
// silently passing against nothing.
const realScorer: Scorer = () => {
  throw new Error("rubric scorer not wired yet — lands in S-02 Phase 2");
};

describe.skipIf(!live)("geography rubric eval (gate)", () => {
  it("scores every labeled example in its correct tier and preserves every ordering", async () => {
    const report = await evaluateRubric(realScorer, EVAL_EXAMPLES, EXPECTED_ORDERINGS);

    expect(report.passed, formatReport(report)).toBe(true);
  }, 120_000);
});
