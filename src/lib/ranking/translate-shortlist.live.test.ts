// LIVE smoke test: one real, schema-constrained translation call. The mocked suite proves the
// batching/parsing logic against fixtures we control; it cannot notice the real model's Polish
// output drifting from the schema this module assumes — that's what this test is for.
//
// Opt-in via TRANSLATION_LIVE_SMOKE=1 (and the usual SUPABASE_TEST_PROJECT=1 + ANTHROPIC_API_KEY),
// so CI stays hermetic and free and a routine `npm test` never spends money. One tiny Sonnet call
// is a fraction of a cent.
//
//   TRANSLATION_LIVE_SMOKE=1 SUPABASE_TEST_PROJECT=1 npx vitest run src/lib/ranking/translate-shortlist.live.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLlmClient } from "@/lib/llm/client";
import { translateShortlist } from "@/lib/ranking/translate-shortlist";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const live = Boolean(
  process.env.TRANSLATION_LIVE_SMOKE === "1" &&
  process.env.SUPABASE_TEST_PROJECT === "1" &&
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  process.env.ANTHROPIC_API_KEY,
);

const TEST_WINDOW = { window_start: "2993-01-06", window_end: "2993-01-12" };

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

describe.skipIf(!live)("translateShortlist (live smoke)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("translates a real Spanish title+lede to Polish", async () => {
    const { data, error } = await db.from("digest").insert(TEST_WINDOW).select("id").single();
    if (error) throw new Error(error.message);

    const llm = createLlmClient(requireEnv("ANTHROPIC_API_KEY"));
    const article = {
      id: "live-smoke-article",
      title: "Los precios de la vivienda suben un 5% en Barcelona",
      lede: "El precio medio de la vivienda en Barcelona subió un 5% interanual en el último trimestre.",
    };

    const result = await translateShortlist(llm, db, data.id, [article], { ceilingUsd: 1 });

    expect(result.ok, result.ok ? "" : `${result.reason}: ${result.message}`).toBe(true);
    if (!result.ok) return;

    const translation = result.data.get(article.id);
    expect(translation).toBeDefined();
    expect(translation?.polishTitle.length).toBeGreaterThan(0);
    expect(translation?.polishTitle).not.toBe(article.title);
    expect(translation?.polishSummary?.length ?? 0).toBeGreaterThan(0);
    expect(translation?.polishSummary).not.toBe(article.lede);

    console.log(`[live smoke] title="${translation?.polishTitle}" summary="${translation?.polishSummary}"`);
  }, 30_000);
});
