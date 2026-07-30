// Integration tests for the ranking orchestrator. Real database, because the guarantees under
// test — persisted cluster/article rows, the shortlist rank cutoff, re-run cleanup, and the state
// transitions — are only meaningful against actual rows and the actual transition trigger.
//
// The LLM transport is a SMART FAKE rather than a static queue (unlike cluster.test.ts and
// score-clusters.test.ts): clustering and scoring both echo back ids the orchestrator only
// generates at runtime (the DB assigns cluster ids on insert), so the fake has to read each
// request's prompt and answer from it, rather than replay a pre-scripted response.
//
// Same opt-in as every integration suite: SUPABASE_TEST_PROJECT=1 alongside the service key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LlmTransport } from "@/lib/llm/client";
import { fakeMessage } from "@/lib/llm/testing";
import { rankDigest } from "@/lib/ranking/rank";
import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { DigestRun } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const TEST_WINDOW_FIRST = "2994-01-01";
const TEST_WINDOW_LAST = "2994-12-31";

let weekIndex = 0;

function nextWeek(): { start: string; end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(2994, 0, 3 + offset))),
    end: iso(new Date(Date.UTC(2994, 0, 9 + offset))),
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

/** A digest already in `ranking` — the state rankDigest assumes its caller has established. */
async function freshRankingDigest(db: ServiceClient): Promise<DigestRun> {
  const created = await createDigest(db, nextWeek());
  if (!created.ok) throw new Error(`${created.reason}: ${created.message}`);
  const transitioned = await transitionDigest(db, created.data.id, "ranking");
  if (!transitioned.ok) throw new Error(`${transitioned.reason}: ${transitioned.message}`);
  return transitioned.data;
}

async function insertArticles(db: ServiceClient, digestId: string, titles: string[]): Promise<void> {
  const rows = titles.map((title, i) => ({
    digest_id: digestId,
    source_name: "Test Source",
    source_url: `https://example.test/rank/${digestId}/${i}`,
    original_title: title,
    original_lede: null,
  }));
  const { error } = await db.from("article").insert(rows);
  if (error) throw new Error(error.message);
}

interface ClusterRow {
  id: string;
  relevance_score: number | null;
  coverage_count: number;
  rank: number | null;
  scoring_detail: { tier?: string } | null;
}

async function clustersFor(db: ServiceClient, digestId: string): Promise<ClusterRow[]> {
  const { data, error } = await db
    .from("cluster")
    .select("id, relevance_score, coverage_count, rank, scoring_detail")
    .eq("digest_id", digestId);
  if (error) throw new Error(error.message);
  return data as ClusterRow[];
}

interface ArticleRow {
  id: string;
  original_title: string;
  polish_title: string | null;
  polish_summary: string | null;
}

async function articlesFor(db: ServiceClient, digestId: string): Promise<ArticleRow[]> {
  const { data, error } = await db
    .from("article")
    .select("id, original_title, polish_title, polish_summary")
    .eq("digest_id", digestId);
  if (error) throw new Error(error.message);
  return data as ArticleRow[];
}

const usage = { input_tokens: 500, output_tokens: 300 };

interface FakeConfig {
  /** Which story a title belongs to — articles sharing a key end up in one cluster. */
  groupOf: (title: string) => string;
  /** The tier/score a cluster earns, from the titles of the articles inside it. */
  tierOf: (titles: string[]) => { tier: string; score: number };
  /** When true, the translation call always returns unparseable output (both attempts). */
  translateFails?: boolean;
}

/**
 * Reads each request's prompt (built by cluster.ts/rubric.ts/translate-shortlist.ts) and answers
 * from it, since the cluster ids it must echo in a scoring response are DB-generated and
 * unknowable in advance. Article ids ARE known in advance (they come from `insertArticles`), so
 * the translation branch can answer with a simple deterministic "PL: <title>" mapping.
 */
function fakeTransport(config: FakeConfig): { transport: LlmTransport; calls: unknown[] } {
  const calls: unknown[] = [];

  const create = ((params: unknown) => {
    calls.push(params);
    const content = (params as { messages: { content: string }[] }).messages[0].content;

    if (content.startsWith("Group these")) {
      const groups = new Map<string, string[]>();
      for (const block of content.split("\n\n").slice(1)) {
        const match = /^\[id: (.+?)\] (.+)/.exec(block);
        if (!match) continue;
        const [, id, title] = match;
        const key = config.groupOf(title);
        const ids = groups.get(key) ?? [];
        ids.push(id);
        groups.set(key, ids);
      }
      const text = JSON.stringify({ clusters: [...groups.values()].map((articleIds) => ({ articleIds })) });
      return Promise.resolve(fakeMessage({ text, usage }));
    }

    if (content.startsWith("Translate each of the following")) {
      if (config.translateFails) {
        return Promise.resolve(fakeMessage({ text: "not valid json", usage }));
      }
      const translations = content
        .split("\n\n")
        .slice(1)
        .map((block) => {
          const idMatch = /^\[articleId: (.+?)\]/.exec(block);
          if (!idMatch) return null;
          const lines = block.split("\n").slice(1);
          const title = lines[0] ?? "";
          return { articleId: idMatch[1], polishTitle: `PL: ${title}`, polishSummary: lines[1] ? `PL: ${lines[1]}` : null };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);
      const text = JSON.stringify({ translations });
      return Promise.resolve(fakeMessage({ text, usage }));
    }

    const scores = content
      .split("\n\n")
      .slice(1)
      .map((block) => {
        const idMatch = /^\[clusterId: (.+?)\]/.exec(block);
        if (!idMatch) return null;
        const titles = [...block.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
        const { tier, score } = config.tierOf(titles);
        return { clusterId: idMatch[1], tier, topics: [], score, rationale: "fake" };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    const text = JSON.stringify({ scores });
    return Promise.resolve(fakeMessage({ text, usage }));
  }) as LlmTransport["messages"]["create"];

  return { transport: { messages: { create } }, calls };
}

let db: ServiceClient;

describe.skipIf(!configured)("rankDigest (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("moves a non-empty pool to ready_for_selection with top-15 ranked and the rest rank-null", async () => {
    const digest = await freshRankingDigest(db);
    const titles = Array.from({ length: 17 }, (_, i) => `Story ${String(i + 1).padStart(2, "0")}`);
    await insertArticles(db, digest.id, titles);

    const { transport } = fakeTransport({
      groupOf: (title) => title, // one article per story: singleton clusters
      tierOf: (titles) => {
        const match = /Story (\d+)/.exec(titles[0]);
        if (!match) throw new Error(`unexpected title: ${titles[0]}`);
        return { tier: "catalonia", score: 100 - Number(match[1]) }; // Story 01 scores highest
      },
    });

    const result = await rankDigest(transport, db, digest, { ceilingUsd: 100 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.digest.status).toBe("ready_for_selection");
    expect(result.data.clusterCount).toBe(17);

    const clusters = await clustersFor(db, digest.id);
    expect(clusters).toHaveLength(17);

    const ranked = clusters
      .filter((c): c is ClusterRow & { rank: number } => c.rank !== null)
      .sort((a, b) => a.rank - b.rank);
    const unranked = clusters.filter((c) => c.rank === null);
    expect(ranked).toHaveLength(15);
    expect(unranked).toHaveLength(2);
    expect(ranked.map((c) => c.rank)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    // Rank 1 is Story 01 (score 99), the highest score in the pool.
    expect(ranked[0].relevance_score).toBe(99);
    expect(ranked[0].scoring_detail?.tier).toBe("catalonia");
    expect(clusters.every((c) => c.coverage_count === 1)).toBe(true);

    // Every shortlisted (rank 1-15) story's singleton article is its own representative, so all
    // 15 should carry a Polish translation; the two unranked stories (18th article excluded by
    // SHORTLIST_SIZE) stay untranslated.
    const articles = await articlesFor(db, digest.id);
    const shortlistedTitles = new Set(titles.slice(0, 15));
    for (const a of articles) {
      if (shortlistedTitles.has(a.original_title)) {
        expect(a.polish_title).toBe(`PL: ${a.original_title}`);
        // insertArticles gives every article a null lede, so the translated summary is null too.
        expect(a.polish_summary).toBeNull();
      } else {
        expect(a.polish_title).toBeNull();
      }
    }
  });

  it("fails an empty pool with last_error, without calling the model", async () => {
    const digest = await freshRankingDigest(db);
    const { transport, calls } = fakeTransport({ groupOf: (t) => t, tierOf: () => ({ tier: "catalonia", score: 90 }) });

    const result = await rankDigest(transport, db, digest, { ceilingUsd: 100 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.digest.status).toBe("failed");
    expect(result.data.digest.last_error).toMatch(/empty/);
    expect(calls).toHaveLength(0);
  });

  it("a re-run deletes prior clusters and re-clusters without duplicating", async () => {
    const digest = await freshRankingDigest(db);
    await insertArticles(db, digest.id, ["Solo A", "Solo B"]);

    // Simulate a stale cluster left behind by a worker that crashed mid-`ranking`.
    const { data: stale, error } = await db
      .from("cluster")
      .insert({ digest_id: digest.id, coverage_count: 1 })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const { transport } = fakeTransport({ groupOf: (t) => t, tierOf: () => ({ tier: "catalonia", score: 90 }) });

    const result = await rankDigest(transport, db, digest, { ceilingUsd: 100 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.digest.status).toBe("ready_for_selection");

    const clusters = await clustersFor(db, digest.id);
    expect(clusters).toHaveLength(2); // Solo A, Solo B — the stale cluster is gone, not tripled up
    expect(clusters.map((c) => c.id)).not.toContain(stale.id);
  });

  it("a ceiling hit during scoring fails the digest with a diagnostic", async () => {
    const digest = await freshRankingDigest(db);
    await insertArticles(db, digest.id, ["Solo A", "Solo B"]);
    const { transport } = fakeTransport({ groupOf: (t) => t, tierOf: () => ({ tier: "catalonia", score: 90 }) });

    // Small enough that clustering's own (nonzero) cost trips the ceiling before scoring runs,
    // but not zero — the ceiling check is `cost_usd >= ceilingUsd`, so a 0 ceiling would also
    // refuse the clustering call itself, which is not the scenario under test.
    const result = await rankDigest(transport, db, digest, { ceilingUsd: 0.0000001 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.digest.status).toBe("failed");
    expect(result.data.digest.last_error).toMatch(/scoring ceiling_reached/);

    // Clustering succeeded (it ran under the ceiling), so its clusters were persisted even
    // though scoring never completed — the digest is `failed`, not silently emptied.
    const clusters = await clustersFor(db, digest.id);
    expect(clusters).toHaveLength(2);
  });

  it("a translation failure fails the digest, after ranking already persisted", async () => {
    const digest = await freshRankingDigest(db);
    await insertArticles(db, digest.id, ["Solo A", "Solo B"]);
    const { transport } = fakeTransport({
      groupOf: (t) => t,
      tierOf: () => ({ tier: "catalonia", score: 90 }),
      translateFails: true,
    });

    const result = await rankDigest(transport, db, digest, { ceilingUsd: 100 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.digest.status).toBe("failed");
    expect(result.data.digest.last_error).toMatch(/translation malformed_output/);

    // Ranking itself succeeded and was persisted before translation ran.
    const clusters = await clustersFor(db, digest.id);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.rank !== null)).toBe(true);
  });
});
