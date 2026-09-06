// The generation stage end to end, against the real database with a fake LLM and a fake fetch.
//
// The weight here is on FAILURE branches, not the happy path: the last two impl-reviews on this
// project both found real bugs in error handling that unit tests missed (an error branch that set
// a flag without returning, and a completeness check that was never enforced). The paths that
// matter are the gate's corrective retry, the lede fallback, the re-run, and the ceiling.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { generateDigest } from "@/lib/generation/generate";
import { fakeLlmTransport, fakeMessage } from "@/lib/llm/testing";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { DigestRun, DigestWindow, RunStateResult } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Year 3000, its own window so this suite never collides with another's synthetic digests. */
const TEST_WINDOW_FIRST = "3000-01-01";
const TEST_WINDOW_LAST = "3000-12-31";

let weekIndex = 0;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextWindow(): DigestWindow {
  const offset = weekIndex * 7;
  weekIndex += 1;
  return {
    start: isoDate(new Date(Date.UTC(3000, 0, 5 + offset))),
    end: isoDate(new Date(Date.UTC(3000, 0, 11 + offset))),
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

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.data;
}

async function purge(): Promise<void> {
  const { error } = await db
    .from("digest")
    .delete()
    .gte("window_start", TEST_WINDOW_FIRST)
    .lte("window_start", TEST_WINDOW_LAST);
  if (error) throw new Error(`failed to purge test digests: ${error.message}`);
}

// Must comfortably clear MIN_ARTICLE_CHARS (600) or extraction returns `too_short` and the stage
// silently takes the lede fallback — which is how the origin assertion below earns its place.
const SOURCE_SENTENCES =
  "El precio medio de la vivienda alcanzó los 4.250 euros por metro cuadrado en agosto, un 8,3% más que un año antes. " +
  "Según el informe publicado esta semana por el observatorio del mercado residencial, la tendencia se mantiene estable en el conjunto de los distritos céntricos de la ciudad. ".repeat(
    6,
  );

/** A page that extracts cleanly and carries exactly two significant figures. */
const ARTICLE_PAGE = `<!doctype html><html><head><title>Vivienda</title></head><body>
  <article><h1>El precio sube</h1><p>${SOURCE_SENTENCES}</p></article>
</body></html>`;

function fakeFetch(outcome: { status?: number; body?: string }): typeof fetch {
  return () => {
    const status = outcome.status ?? 200;
    const bytes = Buffer.from(outcome.body ?? "", "utf8");
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "text/html; charset=utf-8" },
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    } as unknown as Response);
  };
}

/** A model response. `figures` are embedded in the body so the numeric gate sees them. */
function copyResponse(figures: string[] = ["4 250 euro", "8,3%"]): string {
  return JSON.stringify({
    polishTitle: "Ceny mieszkań rosną",
    captionSummary: "Nowe dane o rynku mieszkaniowym.",
    bodyCopy: `Średnia cena sięgnęła ${figures.join(" oraz ")} w sierpniu.`,
    keyStatistics: [{ label: "Cena", value: figures[0] ?? "brak" }],
  });
}

const usage = { input_tokens: 1000, output_tokens: 400 };
const CEILING = 100;

let db: ServiceClient;

/** A digest in `generating` with `size` picked stories, each cluster carrying one article. */
async function seedConfirmedDigest(size: number): Promise<DigestRun> {
  const digest = unwrap(await createDigest(db, nextWindow()));
  unwrap(await transitionDigest(db, digest.id, "ranking"));
  unwrap(await transitionDigest(db, digest.id, "ready_for_selection"));

  const clusterIds: string[] = [];
  for (let i = 0; i < size; i += 1) {
    const { data: cluster, error } = await db
      .from("cluster")
      .insert({ digest_id: digest.id, rank: i + 1, coverage_count: 1 })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    clusterIds.push(cluster.id);

    const { error: articleError } = await db.from("article").insert({
      digest_id: digest.id,
      cluster_id: cluster.id,
      source_name: "Test Source",
      source_url: `https://example.test/story/${digest.id}/${String(i)}`,
      original_title: `Historia ${String(i)}`,
      original_lede: "El precio medio subió un 8,3% hasta 4.250 euros por metro cuadrado en la ciudad.",
      polish_title: `Polski ${String(i)}`,
      language: "es",
    });
    if (articleError) throw new Error(articleError.message);
  }

  const { data: selection, error: selectionError } = await db
    .from("selection")
    .insert({ digest_id: digest.id, format: "single_post", platforms: ["instagram"] })
    .select("id")
    .single();
  if (selectionError) throw new Error(selectionError.message);

  const { error: itemError } = await db
    .from("selection_item")
    .insert(clusterIds.map((id) => ({ selection_id: selection.id, cluster_id: id, picked: true })));
  if (itemError) throw new Error(itemError.message);

  return unwrap(await transitionDigest(db, digest.id, "generating"));
}

async function copyRows(digestId: string) {
  const { data, error } = await db
    .from("generated_copy")
    .select("cluster_id, polish_title, source_text_origin, source_char_count")
    .eq("digest_id", digestId);
  if (error) throw new Error(error.message);
  return data;
}

async function pickedClusterIds(digestId: string): Promise<string[]> {
  const { data, error } = await db
    .from("selection")
    .select("id, selection_item(cluster_id, picked)")
    .eq("digest_id", digestId)
    .single();
  if (error) throw new Error(error.message);
  return data.selection_item.filter((item) => item.picked).map((item) => item.cluster_id);
}

async function statusOf(digestId: string): Promise<{ status: string; last_error: string | null }> {
  const { data, error } = await db.from("digest").select("status, last_error").eq("id", digestId).single();
  if (error) throw new Error(error.message);
  return data;
}

describe.skipIf(!configured)("generateDigest (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("generates every picked story and opens the approval gate", async () => {
    const digest = await seedConfirmedDigest(2);
    const llm = fakeLlmTransport([
      fakeMessage({ text: copyResponse(), usage }),
      fakeMessage({ text: copyResponse(), usage }),
    ]);

    const result = await generateDigest(llm, db, digest, {
      ceilingUsd: CEILING,
      fetchImpl: fakeFetch({ body: ARTICLE_PAGE }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.storyCount).toBe(2);
    expect(result.data.digest.status).toBe("ready_for_approval");
    expect(result.data.digest.generation_completed_at).not.toBeNull();
    expect(await copyRows(digest.id)).toHaveLength(2);
  });

  it("records article origin when the fetch succeeds", async () => {
    const digest = await seedConfirmedDigest(1);
    const llm = fakeLlmTransport([fakeMessage({ text: copyResponse(), usage })]);

    await generateDigest(llm, db, digest, { ceilingUsd: CEILING, fetchImpl: fakeFetch({ body: ARTICLE_PAGE }) });

    const rows = await copyRows(digest.id);
    expect(rows[0].source_text_origin).toBe("article");
  });

  // A blocked source must not cost the week. Idealista is enabled and known to 403.
  it("falls back to the lede when the source is blocked, and still opens the gate", async () => {
    const digest = await seedConfirmedDigest(1);
    const llm = fakeLlmTransport([fakeMessage({ text: copyResponse(), usage })]);

    const result = await generateDigest(llm, db, digest, {
      ceilingUsd: CEILING,
      fetchImpl: fakeFetch({ status: 403 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.digest.status).toBe("ready_for_approval");

    const rows = await copyRows(digest.id);
    expect(rows[0].source_text_origin).toBe("lede");
    expect(rows[0].source_char_count).toBeGreaterThan(0);
  });

  it("retries once with the missing figures named, and succeeds", async () => {
    const digest = await seedConfirmedDigest(1);
    const llm = fakeLlmTransport([
      fakeMessage({ text: copyResponse(["4 250 euro"]), usage }), // drops 8,3%
      fakeMessage({ text: copyResponse(), usage }), // corrected
    ]);

    const result = await generateDigest(llm, db, digest, {
      ceilingUsd: CEILING,
      fetchImpl: fakeFetch({ body: ARTICLE_PAGE }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.digest.status).toBe("ready_for_approval");

    // The retry must NAME what went missing, otherwise it is a re-roll, not a correction.
    const retryPrompt = (llm.calls[1] as { messages: { content: string }[] }).messages[0].content;
    expect(retryPrompt).toContain("dropped or altered figures");
    expect(retryPrompt).toContain("8,3");
  });

  // US-12: wrong figures fail the run rather than publish.
  it("fails the digest when a figure is still missing after the retry", async () => {
    const digest = await seedConfirmedDigest(1);
    const llm = fakeLlmTransport([
      fakeMessage({ text: copyResponse(["4 250 euro"]), usage }),
      fakeMessage({ text: copyResponse(["4 250 euro"]), usage }),
    ]);

    const result = await generateDigest(llm, db, digest, {
      ceilingUsd: CEILING,
      fetchImpl: fakeFetch({ body: ARTICLE_PAGE }),
    });

    // The stage ran to completion; it concluded the digest cannot proceed.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.digest.status).toBe("failed");
    expect(result.data.storyCount).toBe(0);

    const { last_error } = await statusOf(digest.id);
    expect(last_error).toContain("numeric integrity failed");
    expect(last_error).toContain("8,3");

    // Nothing half-generated reaches the approval gate.
    expect(await copyRows(digest.id)).toHaveLength(0);
  });

  it("fails the digest on a ceiling hit rather than throwing", async () => {
    const digest = await seedConfirmedDigest(1);
    const llm = fakeLlmTransport([fakeMessage({ text: copyResponse(), usage })]);

    const result = await generateDigest(llm, db, digest, {
      ceilingUsd: 0,
      fetchImpl: fakeFetch({ body: ARTICLE_PAGE }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.digest.status).toBe("failed");

    const { last_error } = await statusOf(digest.id);
    expect(last_error).toContain("ceiling_reached");
  });

  it("fails the digest when there is no confirmed selection", async () => {
    const digest = unwrap(await createDigest(db, nextWindow()));
    unwrap(await transitionDigest(db, digest.id, "ranking"));
    unwrap(await transitionDigest(db, digest.id, "ready_for_selection"));
    const generating = unwrap(await transitionDigest(db, digest.id, "generating"));
    const llm = fakeLlmTransport([]);

    const result = await generateDigest(llm, db, generating, { ceilingUsd: CEILING });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.digest.status).toBe("failed");

    const { last_error } = await statusOf(digest.id);
    expect(last_error).toContain("no confirmed selection");
  });

  it("fails the digest when the transport is not configured", async () => {
    const digest = await seedConfirmedDigest(1);

    const result = await generateDigest(null, db, digest, {
      ceilingUsd: CEILING,
      fetchImpl: fakeFetch({ body: ARTICLE_PAGE }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.digest.status).toBe("failed");
  });

  // Re-running regenerates from scratch: resuming would let a prompt or model change produce a
  // digest whose stories were written by different configurations.
  //
  // The setup mirrors how a re-run actually arises — a worker that crashed mid-stage leaves the
  // digest STILL in `generating` with partial rows written. It cannot be staged by pushing a
  // finished digest backwards: `digest_transition_guard` rejects ready_for_approval -> generating,
  // which is the state machine working as intended.
  it("deletes prior copy on a re-run rather than duplicating it", async () => {
    const digest = await seedConfirmedDigest(2);
    const clusterIds = (await pickedClusterIds(digest.id)).slice(0, 1);

    // A leftover row from the crashed attempt, with text no fresh run would produce.
    const { error } = await db.from("generated_copy").insert({
      digest_id: digest.id,
      cluster_id: clusterIds[0],
      polish_title: "STALE ROW FROM A CRASHED RUN",
      caption_summary: "stale",
      body_copy: "stale",
      key_statistics: [],
      source_text_origin: "lede",
    });
    if (error) throw new Error(error.message);

    const llm = fakeLlmTransport([
      fakeMessage({ text: copyResponse(), usage }),
      fakeMessage({ text: copyResponse(), usage }),
    ]);
    const result = await generateDigest(llm, db, digest, {
      ceilingUsd: CEILING,
      fetchImpl: fakeFetch({ body: ARTICLE_PAGE }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    const rows = await copyRows(digest.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.polish_title)).not.toContain("STALE ROW FROM A CRASHED RUN");
  });
});
