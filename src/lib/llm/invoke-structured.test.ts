// Integration tests for Phase 3: schema-constrained output, one-reprompt recovery, and the full
// stop-reason taxonomy. Transport MOCKED, cost accounting against the real digest table (each
// attempt — including a reprompt — is a real accounted call).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { invoke, type StructuredRequest } from "@/lib/llm/invoke";
import { fakeLlmTransport, fakeMessage } from "@/lib/llm/testing";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks in 2995 — clear of every other suite. */
const TEST_WINDOW_FIRST = "2995-01-01";
const TEST_WINDOW_LAST = "2995-12-31";

let weekIndex = 0;

function nextWeek(): { window_start: string; window_end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    window_start: iso(new Date(Date.UTC(2995, 0, 6 + offset))),
    window_end: iso(new Date(Date.UTC(2995, 0, 12 + offset))),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the integration suite`);
  return value;
}

function serviceClient() {
  return createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

async function purge(): Promise<void> {
  const { error } = await serviceClient()
    .from("digest")
    .delete()
    .gte("window_start", TEST_WINDOW_FIRST)
    .lte("window_start", TEST_WINDOW_LAST);
  if (error) throw new Error(`failed to purge test digests: ${error.message}`);
}

async function freshDigest(db: ServiceClient): Promise<string> {
  const { data, error } = await db.from("digest").insert(nextWeek()).select("id").single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function costOf(db: ServiceClient, id: string): Promise<number> {
  const { data, error } = await db.from("digest").select("cost_usd").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data.cost_usd;
}

const SCHEMA = z.object({ tier: z.string(), score: z.number() });
const VALID = JSON.stringify({ tier: "a", score: 0.5 });
const WRONG_SHAPE = JSON.stringify({ tier: "a" }); // missing score → zod fails

function request(over: Partial<StructuredRequest<{ tier: string; score: number }>> = {}) {
  return { messages: [{ role: "user" as const, content: "score it" }], maxTokens: 100, schema: SCHEMA, ...over };
}

// 100k input tokens on Sonnet 5 = $0.30 per call.
const usage = { input_tokens: 100_000, output_tokens: 0 };
const HIGH_CEILING = { ceilingUsd: 100 };

let db: ServiceClient;

describe.skipIf(!configured)("invoke — structured output & recovery (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("parses a schema-valid response into typed data", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: VALID, usage })]);

    const result = await invoke(llm, db, id, request(), HIGH_CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.parsed).toEqual({ tier: "a", score: 0.5 });
  });

  it("reprompts once on a malformed response, then succeeds — accounting both calls", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([
      fakeMessage({ text: WRONG_SHAPE, usage }), // first attempt: fails validation
      fakeMessage({ text: VALID, usage }), // reprompt: valid
    ]);

    const result = await invoke(llm, db, id, request(), HIGH_CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.parsed.score).toBe(0.5);
    expect(llm.calls).toHaveLength(2);
    expect(await costOf(db, id)).toBeCloseTo(0.6, 4); // both calls billed
  });

  it("returns malformed_output with both errors after two failures", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([
      fakeMessage({ text: WRONG_SHAPE, usage }),
      fakeMessage({ text: "not json at all", usage }),
    ]);

    const result = await invoke(llm, db, id, request(), HIGH_CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed_output");
    expect(result.message).toContain("[1]");
    expect(result.message).toContain("[2]");
    expect(await costOf(db, id)).toBeCloseTo(0.6, 4); // both attempts billed
  });

  it("refuses the reprompt when the first call exhausted the ceiling", async () => {
    const id = await freshDigest(db);
    // Ceiling is exactly one call's cost, so after the first (malformed) call the retry is refused.
    const llm = fakeLlmTransport([fakeMessage({ text: WRONG_SHAPE, usage })]);

    const result = await invoke(llm, db, id, request(), { ceilingUsd: 0.3 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ceiling_reached");
    expect(llm.calls).toHaveLength(1); // the reprompt never called the transport
  });

  it("rejects an unsupported schema before making any call", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: VALID, usage })]);
    const badSchema = z.object({ score: z.number().min(0) }); // numeric constraint — unsupported

    const result = await invoke(llm, db, id, request({ schema: badSchema as never }), HIGH_CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("api_error");
    expect(result.message).toContain("minimum");
    expect(llm.calls).toHaveLength(0); // no call, no spend
    expect(await costOf(db, id)).toBe(0);
  });
});

describe.skipIf(!configured)("invoke — stop_reason taxonomy (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  const textRequest = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

  it("maps model_context_window_exceeded to context_exceeded", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ stopReason: "model_context_window_exceeded", usage })]);

    const result = await invoke(llm, db, id, textRequest, HIGH_CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("context_exceeded");
  });

  it("maps pause_turn to api_error", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ stopReason: "pause_turn", usage })]);

    const result = await invoke(llm, db, id, textRequest, HIGH_CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("api_error");
    expect(result.message).toContain("pause_turn");
  });

  it("handles a refusal with empty content without throwing", async () => {
    const id = await freshDigest(db);
    // No text → content: [] — the case that crashes naive content[0] indexing.
    const llm = fakeLlmTransport([fakeMessage({ stopReason: "refusal", refusalCategory: "cyber", usage })]);

    const result = await invoke(llm, db, id, textRequest, HIGH_CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("refusal");
    expect(result.message).toContain("cyber");
  });
});
