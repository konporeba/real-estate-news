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
// Each example is scored as a one-article cluster against a throwaway digest — the same invoke()
// path a real cluster takes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLlmClient } from "@/lib/llm/client";
import { EVAL_EXAMPLES, EXPECTED_ORDERINGS } from "@/lib/ranking/eval/examples";
import { evaluateRubric, formatReport, type Scorer } from "@/lib/ranking/eval/harness";
import { scoreExample } from "@/lib/ranking/score-clusters";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const live = Boolean(
  process.env.RANKING_EVAL === "1" &&
  process.env.SUPABASE_TEST_PROJECT === "1" &&
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  process.env.ANTHROPIC_API_KEY,
);

// A far-future throwaway week for the eval's cost accounting; purged before and after.
const EVAL_WINDOW = { window_start: "2993-01-04", window_end: "2993-01-10" };
const EVAL_CEILING = 2; // ~16 singleton calls at sub-cent each sit far under this

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the eval`);
  return value;
}

function serviceClient() {
  return createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

async function purge(): Promise<void> {
  await serviceClient().from("digest").delete().eq("window_start", EVAL_WINDOW.window_start);
}

let db: ServiceClient;
let digestId: string;

describe.skipIf(!live)("geography rubric eval (gate)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
    const { data, error } = await db.from("digest").insert(EVAL_WINDOW).select("id").single();
    if (error) throw new Error(error.message);
    digestId = data.id;
  });
  afterAll(purge);

  it("scores every labeled example in its correct tier and preserves every ordering", async () => {
    const llm = createLlmClient(requireEnv("ANTHROPIC_API_KEY"));
    const scorer: Scorer = (example) => scoreExample(llm, db, digestId, example, EVAL_CEILING);

    const report = await evaluateRubric(scorer, EVAL_EXAMPLES, EXPECTED_ORDERINGS);

    // eslint-disable-next-line no-console -- the eval's job is to report the scores it produced
    console.log(formatReport(report));
    expect(report.passed, formatReport(report)).toBe(true);
  }, 180_000);
});
