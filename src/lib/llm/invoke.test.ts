// Integration tests for the invocation harness. The LLM transport is MOCKED (no spend, no
// network), but the cost accounting runs against the real digest table — the ceiling and the
// accumulation are the guarantees under test, and they live half in Postgres.
//
// Same opt-in as every integration suite: SUPABASE_TEST_PROJECT=1 on top of the service key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { invoke } from "@/lib/llm/invoke";
import { fakeLlmTransport, fakeMessage } from "@/lib/llm/testing";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks in 2996 — clear of every other suite. */
const TEST_WINDOW_FIRST = "2996-01-01";
const TEST_WINDOW_LAST = "2996-12-31";

let weekIndex = 0;

function nextWeek(): { window_start: string; window_end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    window_start: iso(new Date(Date.UTC(2996, 0, 6 + offset))),
    window_end: iso(new Date(Date.UTC(2996, 0, 12 + offset))),
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

async function freshDigest(db: ServiceClient, costUsd = 0): Promise<string> {
  const { data, error } = await db.from("digest").insert(nextWeek()).select("id").single();
  if (error) throw new Error(error.message);
  if (costUsd > 0) {
    const { error: incErr } = await db.rpc("increment_digest_cost", { p_digest_id: data.id, p_delta: costUsd });
    if (incErr) throw new Error(incErr.message);
  }
  return data.id;
}

async function costOf(db: ServiceClient, id: string): Promise<number> {
  const { data, error } = await db.from("digest").select("cost_usd").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data.cost_usd;
}

/** A request stub — the messages content is irrelevant since the transport is mocked. */
const REQUEST = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };
const HIGH_CEILING = { ceilingUsd: 100 };

// 100k input tokens on Sonnet 5 ($3/MTok) = $0.30 — a clean, above-the-rounding-floor amount.
const usage = { input_tokens: 100_000, output_tokens: 0 };

let db: ServiceClient;

describe.skipIf(!configured)("invoke (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("succeeds below the ceiling and increases cost_usd by the call's cost", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: "hello", usage })]);

    const result = await invoke(llm, db, id, REQUEST, HIGH_CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toBe("hello");
    expect(result.data.costUsd).toBeCloseTo(0.3, 4);
    expect(result.data.totalCostUsd).toBeCloseTo(0.3, 4);
    expect(await costOf(db, id)).toBeCloseTo(0.3, 4);
  });

  it("refuses a digest at the ceiling and makes no API call", async () => {
    const id = await freshDigest(db, 5); // already at the ceiling
    const llm = fakeLlmTransport([fakeMessage({ text: "should not be returned", usage })]);

    const result = await invoke(llm, db, id, REQUEST, { ceilingUsd: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ceiling_reached");
    expect(llm.calls).toHaveLength(0); // the transport was never touched
    expect(await costOf(db, id)).toBeCloseTo(5, 4); // unchanged
  });

  it("accounts cost even when the model refuses", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ stopReason: "refusal", usage })]);

    const result = await invoke(llm, db, id, REQUEST, HIGH_CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("refusal");
    // A refusal still billed — the ceiling would be a lie if this were not counted.
    expect(await costOf(db, id)).toBeCloseTo(0.3, 4);
  });

  it("accounts cost even when the response is truncated", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ stopReason: "max_tokens", text: "partial", usage })]);

    const result = await invoke(llm, db, id, REQUEST, HIGH_CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("truncated");
    expect(await costOf(db, id)).toBeCloseTo(0.3, 4);
  });

  it("accumulates concurrent calls against one digest with no lost increments", async () => {
    const id = await freshDigest(db);
    // Each call needs its own staged response; run them concurrently against the one digest.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        invoke(fakeLlmTransport([fakeMessage({ text: "ok", usage })]), db, id, REQUEST, HIGH_CEILING),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    // 10 × $0.30 = $3.00, none lost.
    expect(await costOf(db, id)).toBeCloseTo(3, 4);
  });

  it("surfaces cache token counts from usage", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([
      fakeMessage({
        text: "cached",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 200,
        },
      }),
    ]);

    const result = await invoke(llm, db, id, REQUEST, HIGH_CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.cacheReadTokens).toBe(5000);
    expect(result.data.cacheCreationTokens).toBe(200);
  });

  it("returns not_configured when the client is null, without touching the DB", async () => {
    const id = await freshDigest(db);

    const result = await invoke(null, db, id, REQUEST, HIGH_CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_configured");
    expect(await costOf(db, id)).toBe(0); // no spend recorded
  });
});
