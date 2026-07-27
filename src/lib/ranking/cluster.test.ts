// Unit tests for clusterArticles. LLM transport mocked; cost accounting runs against the real
// digest table (invoke() reads/writes cost_usd) — same opt-in as every integration suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clusterArticles, type ClusterableArticle } from "@/lib/ranking/cluster";
import { fakeLlmTransport, fakeMessage } from "@/lib/llm/testing";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const TEST_WINDOW_FIRST = "2991-01-01";
const TEST_WINDOW_LAST = "2991-12-31";

let weekIndex = 0;

function nextWeek(): { window_start: string; window_end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    window_start: iso(new Date(Date.UTC(2991, 0, 7 + offset))),
    window_end: iso(new Date(Date.UTC(2991, 0, 13 + offset))),
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

const ARTICLES: ClusterableArticle[] = [
  { id: "a1", title: "Story A, outlet 1", lede: null },
  { id: "a2", title: "Story A, outlet 2", lede: null },
  { id: "b1", title: "Story B", lede: null },
];

function groupingResponse(groups: string[][]): string {
  return JSON.stringify({ clusters: groups.map((articleIds) => ({ articleIds })) });
}

const usage = { input_tokens: 300, output_tokens: 100 };
const CEILING = { ceilingUsd: 100 };

let db: ServiceClient;

describe.skipIf(!configured)("clusterArticles (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("partitions a known article set into the expected clusters", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: groupingResponse([["a1", "a2"], ["b1"]]), usage })]);

    const result = await clusterArticles(llm, db, id, ARTICLES, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data.find((c) => c.articleIds.includes("a1"))?.articleIds.sort()).toEqual(["a1", "a2"]);
    expect(result.data.find((c) => c.articleIds.includes("b1"))?.articleIds).toEqual(["b1"]);
  });

  it("rejects a grouping that drops an article id", async () => {
    const id = await freshDigest(db);
    // b1 never appears in any group.
    const llm = fakeLlmTransport([fakeMessage({ text: groupingResponse([["a1", "a2"]]), usage })]);

    const result = await clusterArticles(llm, db, id, ARTICLES, CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed_output");
    expect(result.message).toMatch(/missing/);
  });

  it("rejects a grouping that duplicates an article id across groups", async () => {
    const id = await freshDigest(db);
    // a1 appears in two groups.
    const llm = fakeLlmTransport([fakeMessage({ text: groupingResponse([["a1", "a2"], ["a1"], ["b1"]]), usage })]);

    const result = await clusterArticles(llm, db, id, ARTICLES, CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed_output");
    expect(result.message).toMatch(/duplicated/);
  });

  it("rejects a grouping that invents an unknown article id", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: groupingResponse([["a1", "a2"], ["b1"], ["ghost"]]), usage })]);

    const result = await clusterArticles(llm, db, id, ARTICLES, CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed_output");
    expect(result.message).toMatch(/unknown/);
  });

  it("returns an empty list for no articles without calling the model", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([]);

    const result = await clusterArticles(llm, db, id, [], CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("treats a singleton article as a cluster of one", async () => {
    const id = await freshDigest(db);
    const solo: ClusterableArticle[] = [{ id: "only", title: "Unique story", lede: null }];
    const llm = fakeLlmTransport([fakeMessage({ text: groupingResponse([["only"]]), usage })]);

    const result = await clusterArticles(llm, db, id, solo, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([{ articleIds: ["only"] }]);
  });
});
