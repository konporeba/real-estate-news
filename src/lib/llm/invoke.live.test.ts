// LIVE smoke test: one real, schema-constrained Anthropic call. The recorded fixtures in the
// other suites prove the harness handles the SDK shapes we CAPTURED; they cannot notice the real
// `usage` object, error taxonomy, or structured-output behavior drifting from those assumptions —
// which is exactly the class of failure the S-01 live smoke caught within minutes of existing.
//
// Opt-in via LLM_LIVE_SMOKE=1 (and the usual SUPABASE_TEST_PROJECT=1 + ANTHROPIC_API_KEY), so CI
// stays hermetic and free and a routine `npm test` never spends money. One tiny Sonnet call is a
// fraction of a cent.
//
//   LLM_LIVE_SMOKE=1 SUPABASE_TEST_PROJECT=1 npx vitest run src/lib/llm/invoke.live.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createLlmClient } from "@/lib/llm/client";
import { invoke } from "@/lib/llm/invoke";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const live = Boolean(
  process.env.LLM_LIVE_SMOKE === "1" &&
  process.env.SUPABASE_TEST_PROJECT === "1" &&
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  process.env.ANTHROPIC_API_KEY,
);

const TEST_WINDOW = { window_start: "2994-01-06", window_end: "2994-01-12" };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the live smoke test`);
  return value;
}

function serviceClient() {
  return createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

async function purge(): Promise<void> {
  await serviceClient().from("digest").delete().eq("window_start", TEST_WINDOW.window_start);
}

let db: ServiceClient;

describe.skipIf(!live)("invoke (live smoke)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("makes one real schema-constrained call and accounts a plausible cost", async () => {
    const { data, error } = await db.from("digest").insert(TEST_WINDOW).select("id").single();
    if (error) throw new Error(error.message);

    const llm = createLlmClient(requireEnv("ANTHROPIC_API_KEY"));
    const schema = z.object({ answer: z.number() });

    const result = await invoke(
      llm,
      db,
      data.id,
      {
        messages: [{ role: "user", content: 'What is 2 + 2? Reply as JSON: { "answer": <number> }.' }],
        maxTokens: 64,
        schema,
      },
      { ceilingUsd: 1 },
    );

    expect(result.ok, result.ok ? "" : `${result.reason}: ${result.message}`).toBe(true);
    if (!result.ok) return;

    // The parsed shape the whole harness assumes.
    expect(result.data.parsed.answer).toBe(4);

    // The usage fields the accounting reads must all be present and real.
    expect(result.data.usage.input_tokens).toBeGreaterThan(0);
    expect(result.data.usage.output_tokens).toBeGreaterThan(0);
    expect(typeof result.data.usage.cache_read_input_tokens).not.toBe("undefined");
    expect(typeof result.data.usage.cache_creation_input_tokens).not.toBe("undefined");

    // A real Sonnet call sits at fractions of a cent — above the rounding floor, below the ceiling.
    expect(result.data.costUsd).toBeGreaterThan(0);
    expect(result.data.costUsd).toBeLessThan(0.05);
    expect(result.data.totalCostUsd).toBeCloseTo(result.data.costUsd, 4);

    console.log(
      `[live smoke] in=${result.data.usage.input_tokens} out=${result.data.usage.output_tokens} ` +
        `cost=$${result.data.costUsd.toFixed(6)} → cost_usd=$${result.data.totalCostUsd}`,
    );
  }, 30_000);
});
