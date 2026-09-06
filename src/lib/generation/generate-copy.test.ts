// Control flow for the generation call, not copy quality. The LLM transport is mocked; cost
// accounting runs against the real digest table (invoke() reads and writes cost_usd), the same
// opt-in every integration suite uses.
//
// Copy quality has no regression gate by design — "good social copy" has no ground truth the way
// a geography tier does, so it is judged by the operator reading real output. What IS testable is
// that a failure propagates instead of throwing, that the format reaches the prompt, and that a
// schema-valid-but-empty response is rejected before it can reach the approval gate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateCopy, GENERATION_MODEL } from "@/lib/generation/generate-copy";
import { CAROUSEL_SLIDES, KEY_STATISTICS_MAX, type GenerationStory } from "@/lib/generation/prompt";
import { fakeLlmTransport, fakeMessage } from "@/lib/llm/testing";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Year 3001, its own window so this suite never collides with another's synthetic digests. */
const TEST_WINDOW_FIRST = "3001-01-01";
const TEST_WINDOW_LAST = "3001-12-31";

let weekIndex = 0;

function nextWeek(): { window_start: string; window_end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    window_start: iso(new Date(Date.UTC(3001, 0, 5 + offset))),
    window_end: iso(new Date(Date.UTC(3001, 0, 11 + offset))),
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

const STORY: GenerationStory = {
  title: "El precio de la vivienda sube un 8,3% en Barcelona",
  sourceText: "El precio medio alcanzó los 4.250 euros por metro cuadrado en agosto, un 8,3% más que un año antes.",
};

function response(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    polishTitle: "Ceny mieszkań w Barcelonie rosną o 8,3%",
    captionSummary: "Średnia cena sięgnęła 4 250 euro za metr kwadratowy.",
    bodyCopy: "Pierwszy akapit.\n\nDrugi akapit.",
    keyStatistics: [
      { label: "Cena za metr", value: "4 250 euro" },
      { label: "Wzrost roczny", value: "8,3%" },
      { label: "Miesiąc", value: "sierpień" },
    ],
    ...over,
  });
}

const usage = { input_tokens: 1200, output_tokens: 600 };
const CEILING = { ceilingUsd: 100 };

let db: ServiceClient;

describe.skipIf(!configured)("generateCopy (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("parses a story's adaptation", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: response(), usage })]);

    const result = await generateCopy(llm, db, id, STORY, "single_post", CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.polishTitle).toBe("Ceny mieszkań w Barcelonie rosną o 8,3%");
    expect(result.data.keyStatistics).toHaveLength(3);
  });

  it("sends the story's source text and the generation model", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: response(), usage })]);

    await generateCopy(llm, db, id, STORY, "single_post", CEILING);

    const sent = llm.calls[0] as { model: string; messages: { content: string }[] };
    expect(sent.model).toBe(GENERATION_MODEL);
    expect(sent.messages[0].content).toContain("4.250 euros por metro cuadrado");
    expect(sent.messages[0].content).toContain(STORY.title);
  });

  it("asks for slides only when the format is carousel", async () => {
    const single = await freshDigest(db);
    const carousel = await freshDigest(db);
    const llmSingle = fakeLlmTransport([fakeMessage({ text: response(), usage })]);
    const llmCarousel = fakeLlmTransport([fakeMessage({ text: response(), usage })]);

    await generateCopy(llmSingle, db, single, STORY, "single_post", CEILING);
    await generateCopy(llmCarousel, db, carousel, STORY, "carousel", CEILING);

    const singlePrompt = (llmSingle.calls[0] as { messages: { content: string }[] }).messages[0].content;
    const carouselPrompt = (llmCarousel.calls[0] as { messages: { content: string }[] }).messages[0].content;

    expect(carouselPrompt).toContain(`exactly ${String(CAROUSEL_SLIDES)} carousel slides`);
    expect(singlePrompt).not.toContain("carousel slides");
    expect(singlePrompt).toContain("single post");
  });

  it("appends a correction when one is given — the gate's retry path", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: response(), usage })]);

    await generateCopy(llm, db, id, STORY, "single_post", {
      ...CEILING,
      correction: "You dropped these figures: 4.250",
    });

    const sent = (llm.calls[0] as { messages: { content: string }[] }).messages[0].content;
    expect(sent).toContain("You dropped these figures: 4.250");
  });

  it("propagates a ceiling hit unchanged rather than throwing", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: response(), usage })]);

    const result = await generateCopy(llm, db, id, STORY, "single_post", { ceilingUsd: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the ceiling to stop the call");
    expect(result.reason).toBe("ceiling_reached");
  });

  it("propagates a transport failure rather than throwing", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([new Error("connection reset"), new Error("connection reset")]);

    const result = await generateCopy(llm, db, id, STORY, "single_post", CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the transport failure to surface");
    expect(result.reason).toBe("api_error");
  });

  it("returns not_configured for a null transport", async () => {
    const id = await freshDigest(db);

    const result = await generateCopy(null, db, id, STORY, "single_post", CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not_configured");
    expect(result.reason).toBe("not_configured");
  });

  // A NOT NULL column accepts "". Without this check an empty post would reach the S-07 approval
  // gate looking publishable, which is worse than failing the run.
  it("rejects a schema-valid but empty adaptation", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([fakeMessage({ text: response({ polishTitle: "   " }), usage })]);

    const result = await generateCopy(llm, db, id, STORY, "single_post", CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an empty title to be rejected");
    expect(result.reason).toBe("malformed_output");
  });

  it("trims an over-long statistics list rather than failing usable copy", async () => {
    const id = await freshDigest(db);
    const tooMany = Array.from({ length: KEY_STATISTICS_MAX + 3 }, (_, i) => ({
      label: `Etykieta ${String(i)}`,
      value: `${String(i)}%`,
    }));
    const llm = fakeLlmTransport([fakeMessage({ text: response({ keyStatistics: tooMany }), usage })]);

    const result = await generateCopy(llm, db, id, STORY, "single_post", CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.keyStatistics).toHaveLength(KEY_STATISTICS_MAX);
  });

  // The prompt prefers fewer statistics to invented ones, so a short list is correct output.
  it("accepts fewer statistics than the requested minimum", async () => {
    const id = await freshDigest(db);
    const llm = fakeLlmTransport([
      fakeMessage({ text: response({ keyStatistics: [{ label: "Wzrost", value: "8,3%" }] }), usage }),
    ]);

    const result = await generateCopy(llm, db, id, STORY, "single_post", CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.keyStatistics).toHaveLength(1);
  });
});
