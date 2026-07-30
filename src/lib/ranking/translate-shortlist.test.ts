// Unit tests for translateShortlist. The LLM transport is mocked, but cost accounting runs against
// the real digest table (invoke() reads/writes cost_usd) — same opt-in as every integration suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fakeLlmTransport, fakeMessage } from "@/lib/llm/testing";
import { translateShortlist, type TranslatableArticle } from "@/lib/ranking/translate-shortlist";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const TEST_WINDOW_FIRST = "2993-01-01";
const TEST_WINDOW_LAST = "2993-12-31";

let weekIndex = 0;

function nextWeek(): { window_start: string; window_end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    window_start: iso(new Date(Date.UTC(2993, 0, 5 + offset))),
    window_end: iso(new Date(Date.UTC(2993, 0, 11 + offset))),
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

function article(id: string, lede: string | null = `lede ${id}`): TranslatableArticle {
  return { id, title: `title ${id}`, lede };
}

/** A fake batch response translating the given ids. */
function batchResponse(translations: { articleId: string; polishTitle: string; polishSummary: string | null }[]): string {
  return JSON.stringify({ translations });
}

const usage = { input_tokens: 500, output_tokens: 200 };
const CEILING = { ceilingUsd: 100 };

let db: ServiceClient;

describe.skipIf(!configured)("translateShortlist (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("parses a batched multi-article response into per-article translations", async () => {
    const id = await freshDigest(db);
    const articles = [article("a1"), article("a2")];
    const llm = fakeLlmTransport([
      fakeMessage({
        text: batchResponse([
          { articleId: "a1", polishTitle: "Tytuł 1", polishSummary: "Streszczenie 1" },
          { articleId: "a2", polishTitle: "Tytuł 2", polishSummary: "Streszczenie 2" },
        ]),
        usage,
      }),
    ]);

    const result = await translateShortlist(llm, db, id, articles, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.get("a1")).toEqual({ polishTitle: "Tytuł 1", polishSummary: "Streszczenie 1" });
    expect(result.data.get("a2")?.polishTitle).toBe("Tytuł 2");
    expect(llm.calls).toHaveLength(1);
  });

  it("triggers F-03's reprompt on a malformed batch, then succeeds", async () => {
    const id = await freshDigest(db);
    const articles = [article("a1")];
    const llm = fakeLlmTransport([
      fakeMessage({ text: "not json at all", usage }), // first attempt fails schema
      fakeMessage({ text: batchResponse([{ articleId: "a1", polishTitle: "Tytuł 1", polishSummary: "Streszczenie 1" }]), usage }),
    ]);

    const result = await translateShortlist(llm, db, id, articles, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.get("a1")?.polishTitle).toBe("Tytuł 1");
    expect(llm.calls).toHaveLength(2);
  });

  it("returns malformed_output when a batch omits a requested article", async () => {
    const id = await freshDigest(db);
    const articles = [article("a1"), article("a2")];
    const llm = fakeLlmTransport([
      fakeMessage({ text: batchResponse([{ articleId: "a1", polishTitle: "Tytuł 1", polishSummary: "Streszczenie 1" }]), usage }),
    ]);

    const result = await translateShortlist(llm, db, id, articles, CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed_output");
    expect(result.message).toContain("a2");
  });

  it("propagates a ceiling_reached from the batch call", async () => {
    const id = await freshDigest(db);
    await db.rpc("increment_digest_cost", { p_digest_id: id, p_delta: 1 });
    const llm = fakeLlmTransport([
      fakeMessage({ text: batchResponse([{ articleId: "a1", polishTitle: "Tytuł 1", polishSummary: "Streszczenie 1" }]), usage }),
    ]);

    const result = await translateShortlist(llm, db, id, [article("a1")], { ceilingUsd: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ceiling_reached");
  });

  it("accepts a null polishSummary for an article with no lede", async () => {
    const id = await freshDigest(db);
    const articles = [article("a1", null)];
    const llm = fakeLlmTransport([
      fakeMessage({ text: batchResponse([{ articleId: "a1", polishTitle: "Tytuł 1", polishSummary: null }]), usage }),
    ]);

    const result = await translateShortlist(llm, db, id, articles, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.get("a1")).toEqual({ polishTitle: "Tytuł 1", polishSummary: null });
  });

  it("returns an empty map for no articles without calling the model", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([]);

    const result = await translateShortlist(llm, db, id, [], CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.size).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });
});
