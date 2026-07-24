// Integration tests for the collection orchestrator. They exercise the real database
// because the guarantees under test — per-source isolation, fallback escalation, top-up
// dedupe via the unique index, and the state transitions — are only meaningful against
// actual rows and the actual transition trigger.
//
// The tier registry is MOCKED, so no live Spanish news site is touched: the suite is
// deterministic and offline apart from Supabase itself. vi.mock rather than vi.spyOn
// because collect.ts binds `adapterFor` at import time; spying on the ESM namespace
// would leave that binding pointing at the real implementation.
//
// Same opt-in as the run-state suite: SUPABASE_TEST_PROJECT=1 on top of the service key,
// so pointing an RLS-bypassing write suite at a project is always deliberate.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Candidate } from "@/lib/collection/adapters/types";
import { MIN_POOL_SIZE, type SourceDefinition } from "@/lib/collection/sources";
import { createDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { DigestRun, DigestWindow, RunStateResult } from "@/types";

/** Hoisted so the vi.mock factory below can close over it; mutated per test. */
const { plan } = vi.hoisted(() => {
  const plan: { current: Record<string, Candidate[] | Error | undefined> } = { current: {} };
  return { plan };
});

vi.mock("@/lib/collection/adapters", () => ({
  adapterFor: () => (definition: SourceDefinition) => {
    const outcome = plan.current[definition.slug];
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome ?? []);
  },
}));

// Imported after the mock declaration for clarity; vi.mock is hoisted above it regardless.
const { collect } = await import("@/lib/collection/collect");

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks in 1971 — a year apart from the run-state suite's 1970 rows. */
const TEST_WINDOW_FIRST = "1971-01-01";
const TEST_WINDOW_LAST = "1971-12-31";

let weekIndex = 0;

function nextWindow(): DigestWindow {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(1971, 0, 4 + offset))),
    end: iso(new Date(Date.UTC(1971, 0, 10 + offset))),
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
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.data;
}

async function purge(): Promise<void> {
  const { error } = await serviceClient()
    .from("digest")
    .delete()
    .gte("window_start", TEST_WINDOW_FIRST)
    .lte("window_start", TEST_WINDOW_LAST);
  if (error) throw new Error(`failed to purge test digests: ${error.message}`);
}

function source(slug: string, role: "primary" | "fallback" = "primary"): SourceDefinition {
  return {
    slug,
    name: `Source ${slug}`,
    tier: "rss",
    role,
    language: "es",
    url: `https://example.test/${slug}/feed`,
    enabled: true,
  };
}

function articleUrl(slug: string, n: number): string {
  return `https://example.test/${slug}/article-${n}`;
}

/** Undated candidates, so the window filter always keeps them (see collect.ts inWindow). */
function candidates(slug: string, count: number): Candidate[] {
  return Array.from({ length: count }, (_, i) => ({
    sourceUrl: articleUrl(slug, i),
    title: `${slug} article ${i}`,
    lede: `lede for ${slug} ${i}`,
    publishedAt: null,
  }));
}

async function freshDigest(db: ServiceClient): Promise<DigestRun> {
  return unwrap(await createDigest(db, nextWindow()));
}

async function articleCount(db: ServiceClient, digestId: string): Promise<number> {
  const { count, error } = await db
    .from("article")
    .select("id", { count: "exact", head: true })
    .eq("digest_id", digestId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

let db: ServiceClient;

describe.skipIf(!configured)("collect (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);
  beforeEach(() => {
    plan.current = {};
  });

  it("isolates a throwing source: the run completes and records the failure", async () => {
    const digest = await freshDigest(db);
    plan.current = {
      good: candidates("good", MIN_POOL_SIZE + 5),
      blocked: new Error("403 Forbidden"),
    };

    const { report, digest: after } = unwrap(
      await collect(db, digest, { sources: [source("good"), source("blocked")] }),
    );

    // The run did not abort.
    expect(after.status).toBe("ranking");

    const blocked = report.sources.find((s) => s.slug === "blocked");
    expect(blocked?.status).toBe("failed");
    expect(blocked?.error).toContain("403 Forbidden");

    const good = report.sources.find((s) => s.slug === "good");
    expect(good?.status).toBe("ok");
    expect(good?.itemsInserted).toBe(MIN_POOL_SIZE + 5);
  });

  it("escalates to fallback sources only when the primary pool is thin", async () => {
    const digest = await freshDigest(db);
    plan.current = { thin: candidates("thin", 3), backup: candidates("backup", 4) };

    const { report } = unwrap(await collect(db, digest, { sources: [source("thin"), source("backup", "fallback")] }));

    expect(report.fallbacksRan).toBe(true);
    expect(report.sources.find((s) => s.slug === "backup")?.status).toBe("ok");
    expect(report.poolSize).toBe(7);
    expect(report.thresholdMet).toBe(false);
  });

  it("leaves fallback sources untouched when the primary pool is healthy", async () => {
    const digest = await freshDigest(db);
    plan.current = { plenty: candidates("plenty", MIN_POOL_SIZE + 1), backup: candidates("backup", 9) };

    const { report } = unwrap(await collect(db, digest, { sources: [source("plenty"), source("backup", "fallback")] }));

    expect(report.fallbacksRan).toBe(false);
    expect(report.thresholdMet).toBe(true);
    // Recorded as skipped rather than omitted, so the report accounts for every source.
    expect(report.sources.find((s) => s.slug === "backup")?.status).toBe("skipped");
    expect(await articleCount(db, digest.id)).toBe(MIN_POOL_SIZE + 1);
  });

  // The real top-up shape: a worker killed mid-run leaves articles behind with the digest
  // still in `collecting`. Re-running must add only what is missing (FR-018, US-04).
  it("tops up a partially collected digest without duplicating", async () => {
    const digest = await freshDigest(db);

    // Simulate the interrupted run: three of the seven URLs already persisted.
    const { error } = await db.from("article").insert(
      [0, 1, 2].map((n) => ({
        digest_id: digest.id,
        source_name: "Source topup",
        source_url: articleUrl("topup", n),
        original_title: `topup article ${n}`,
        original_lede: null,
        published_at: null,
      })),
    );
    expect(error).toBeNull();

    plan.current = { topup: candidates("topup", 7) };
    const { report } = unwrap(await collect(db, digest, { sources: [source("topup")] }));

    expect(await articleCount(db, digest.id)).toBe(7);
    expect(report.sources.find((s) => s.slug === "topup")?.itemsFetched).toBe(7);
    expect(report.sources.find((s) => s.slug === "topup")?.itemsInserted).toBe(4);
  });

  it("collapses the same URL syndicated by two sources in one run", async () => {
    const digest = await freshDigest(db);
    const shared: Candidate = {
      sourceUrl: "https://example.test/shared/story",
      title: "the same story",
      lede: null,
      publishedAt: null,
    };
    plan.current = { one: [shared], two: [shared] };

    unwrap(await collect(db, digest, { sources: [source("one"), source("two")] }));

    expect(await articleCount(db, digest.id)).toBe(1);
  });

  it("moves a non-empty pool to ranking and stamps the checkpoint", async () => {
    const digest = await freshDigest(db);
    plan.current = { any: candidates("any", 2) };

    const { digest: after } = unwrap(await collect(db, digest, { sources: [source("any")] }));

    expect(after.status).toBe("ranking");
    expect(after.collection_completed_at).not.toBeNull();
    expect(after.last_error).toBeNull();
  });

  it("fails an empty pool with a diagnostic rather than advancing silently", async () => {
    const digest = await freshDigest(db);
    plan.current = { dead: new Error("ETIMEDOUT") };

    const { digest: after, report } = unwrap(await collect(db, digest, { sources: [source("dead")] }));

    expect(after.status).toBe("failed");
    expect(after.last_error).toContain("no articles");
    expect(report.poolSize).toBe(0);
  });

  it("persists the report even when the run fails, so a thin week is explainable", async () => {
    const digest = await freshDigest(db);
    plan.current = { dead: new Error("ECONNREFUSED") };

    unwrap(await collect(db, digest, { sources: [source("dead")] }));

    const { data, error } = await db.from("digest").select("collection_report").eq("id", digest.id).single();
    expect(error).toBeNull();
    expect(data?.collection_report).not.toBeNull();
  });

  it("records that AI web search was skipped rather than staying silent", async () => {
    const digest = await freshDigest(db);
    plan.current = { any: candidates("any", 1) };

    const { report } = unwrap(await collect(db, digest, { sources: [source("any")] }));

    expect(report.aiWebSearchSkipped).toBe(true);
  });
});
