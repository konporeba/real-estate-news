// Integration tests for the atomic cost-increment primitive (F-03 Phase 1). They exercise the
// real `increment_digest_cost` function, because its guarantees — atomicity under concurrency and
// the numeric(10,4) rounding floor — live in Postgres, not in TypeScript.
//
// The function is called via rpc() directly here; the typed wrapper the harness uses lands in
// Phase 2. Same opt-in as every other integration suite: SUPABASE_TEST_PROJECT=1 on top of the
// service key, so pointing an RLS-bypassing write suite at a project is always deliberate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks in 2997 — clear of every other suite's range. */
const TEST_WINDOW_FIRST = "2997-01-01";
const TEST_WINDOW_LAST = "2997-12-31";

let weekIndex = 0;

function nextWeek(): { start: string; end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(2997, 0, 5 + offset))),
    end: iso(new Date(Date.UTC(2997, 0, 11 + offset))),
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

async function freshDigestId(db: ServiceClient): Promise<string> {
  const week = nextWeek();
  const { data, error } = await db
    .from("digest")
    .insert({ window_start: week.start, window_end: week.end })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function increment(db: ServiceClient, id: string, delta: number): Promise<number | null> {
  const { data, error } = await db.rpc("increment_digest_cost", { p_digest_id: id, p_delta: delta });
  if (error) throw new Error(error.message);
  return data;
}

async function costOf(db: ServiceClient, id: string): Promise<number> {
  const { data, error } = await db.from("digest").select("cost_usd").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data.cost_usd;
}

let db: ServiceClient;

describe.skipIf(!configured)("increment_digest_cost (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purge();
  });
  afterAll(purge);

  it("returns the post-increment total", async () => {
    const id = await freshDigestId(db);
    expect(await increment(db, id, 0.0123)).toBeCloseTo(0.0123, 4);
    expect(await increment(db, id, 0.5)).toBeCloseTo(0.5123, 4);
  });

  // The reason this is an RPC and not app-side arithmetic: a read-modify-write would lose
  // increments here. S-02 scores ~234 articles, so this concurrency is real, not hypothetical.
  it("loses no increments under concurrency", async () => {
    const id = await freshDigestId(db);
    await Promise.all(Array.from({ length: 20 }, () => increment(db, id, 0.01)));
    expect(await costOf(db, id)).toBeCloseTo(0.2, 4);
  });

  it("returns null for an unknown digest rather than erroring", async () => {
    expect(await increment(db, "00000000-0000-0000-0000-000000000000", 1)).toBeNull();
  });

  // Row 1.5: numeric(10,4) rounds a sub-$0.00005 delta to zero on store. Documented, not a defect
  // — real Sonnet calls sit at cents. This asserts the limit against the real column so nobody
  // later assumes cost_usd is exact to the penny fraction.
  it("rounds a sub-$0.00005 increment to zero (numeric(10,4) floor)", async () => {
    const id = await freshDigestId(db);
    await increment(db, id, 0.00004);
    expect(await costOf(db, id)).toBe(0);

    // Just above the floor is retained (rounds to the 4th decimal).
    await increment(db, id, 0.00006);
    expect(await costOf(db, id)).toBeCloseTo(0.0001, 4);
  });
});
