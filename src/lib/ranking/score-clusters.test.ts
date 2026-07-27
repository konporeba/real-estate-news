// Unit tests for scoreClusters. The LLM transport is mocked, but cost accounting runs against the
// real digest table (invoke() reads/writes cost_usd) — same opt-in as every integration suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fakeLlmTransport, fakeMessage } from "@/lib/llm/testing";
import { scoreClusters, type ScorableCluster } from "@/lib/ranking/score-clusters";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const TEST_WINDOW_FIRST = "2992-01-01";
const TEST_WINDOW_LAST = "2992-12-31";

let weekIndex = 0;

function nextWeek(): { window_start: string; window_end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    window_start: iso(new Date(Date.UTC(2992, 0, 5 + offset))),
    window_end: iso(new Date(Date.UTC(2992, 0, 11 + offset))),
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

function cluster(id: string): ScorableCluster {
  return { id, articles: [{ title: `title ${id}`, lede: `lede ${id}` }] };
}

/** A fake batch response scoring the given ids. */
function batchResponse(scores: { clusterId: string; tier: string; score: number }[]): string {
  return JSON.stringify({
    scores: scores.map((s) => ({ ...s, topics: [], rationale: "because" })),
  });
}

const usage = { input_tokens: 500, output_tokens: 200 };
const CEILING = { ceilingUsd: 100 };

let db: ServiceClient;

describe.skipIf(!configured)("scoreClusters (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("parses a batched multi-cluster response into per-cluster scores", async () => {
    const id = await freshDigest(db);
    const clusters = [cluster("c1"), cluster("c2"), cluster("c3")];
    const llm = fakeLlmTransport([
      fakeMessage({
        text: batchResponse([
          { clusterId: "c1", tier: "catalonia", score: 90 },
          { clusterId: "c2", tier: "national", score: 60 },
          { clusterId: "c3", tier: "discard", score: 5 },
        ]),
        usage,
      }),
    ]);

    const result = await scoreClusters(llm, db, id, clusters, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.get("c1")?.tier).toBe("catalonia");
    expect(result.data.get("c2")?.score).toBe(60);
    expect(result.data.get("c3")?.tier).toBe("discard");
    expect(llm.calls).toHaveLength(1); // 3 clusters fit one batch
  });

  it("triggers F-03's reprompt on a malformed batch, then succeeds", async () => {
    const id = await freshDigest(db);
    const clusters = [cluster("c1")];
    const llm = fakeLlmTransport([
      fakeMessage({ text: "not json at all", usage }), // first attempt fails schema
      fakeMessage({ text: batchResponse([{ clusterId: "c1", tier: "national", score: 55 }]), usage }), // reprompt valid
    ]);

    const result = await scoreClusters(llm, db, id, clusters, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.get("c1")?.score).toBe(55);
    expect(llm.calls).toHaveLength(2); // reprompt happened
  });

  it("returns malformed_output when a batch omits a requested cluster", async () => {
    const id = await freshDigest(db);
    const clusters = [cluster("c1"), cluster("c2")];
    // Schema-valid response, but c2 is missing — invoke's reprompt can't catch this.
    const llm = fakeLlmTransport([
      fakeMessage({ text: batchResponse([{ clusterId: "c1", tier: "national", score: 55 }]), usage }),
    ]);

    const result = await scoreClusters(llm, db, id, clusters, CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed_output");
    expect(result.message).toContain("c2");
  });

  it("propagates a ceiling_reached from a batch", async () => {
    const id = await freshDigest(db);
    // Pre-spend to the ceiling so the scoring call is refused.
    await db.rpc("increment_digest_cost", { p_digest_id: id, p_delta: 1 });
    const llm = fakeLlmTransport([
      fakeMessage({ text: batchResponse([{ clusterId: "c1", tier: "national", score: 55 }]), usage }),
    ]);

    const result = await scoreClusters(llm, db, id, [cluster("c1")], { ceilingUsd: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ceiling_reached");
  });

  it("returns an empty map for no clusters without calling the model", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([]);

    const result = await scoreClusters(llm, db, id, [], CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.size).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("rejects a score out of the 0–100 range (schema can't range-check)", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([
      fakeMessage({ text: batchResponse([{ clusterId: "c1", tier: "catalonia", score: 250 }]), usage }),
    ]);

    await expect(scoreClusters(llm, db, id, [cluster("c1")], CEILING)).rejects.toThrow(/0–100/);
  });
});
