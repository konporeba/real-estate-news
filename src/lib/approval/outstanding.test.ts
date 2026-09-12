// Integration tests for the FR-021 outstanding-gate query. Runs against the real database,
// because the claim under test is a real WHERE clause against real digest statuses.
//
// Target: whatever SUPABASE_URL points at, using the service-role key from `.env`. Every row is
// written into synthetic 3004 week windows (a year of its own — 3003 is content-approval-gate's
// own record.test.ts, 3100/3200 are visuals') and purged before and after the run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findOutstandingGates } from "@/lib/approval/outstanding";
import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { DigestWindow, RunStateResult } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const TEST_WINDOW_FIRST = "3004-01-01";
const TEST_WINDOW_LAST = "3004-12-31";

let weekIndex = 0;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextWindow(): DigestWindow {
  const offset = weekIndex * 7;
  weekIndex += 1;
  return {
    start: isoDate(new Date(Date.UTC(3004, 0, 5 + offset))),
    end: isoDate(new Date(Date.UTC(3004, 0, 11 + offset))),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the integration suite`);
  return value;
}

function serviceClient(): ServiceClient {
  return createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.data;
}

async function purgeTestDigests(): Promise<void> {
  const { error } = await serviceClient()
    .from("digest")
    .delete()
    .gte("window_start", TEST_WINDOW_FIRST)
    .lte("window_start", TEST_WINDOW_LAST);
  if (error) throw new Error(`failed to purge test digests: ${error.message}`);
}

/** Any digest outside the synthetic range currently at either gate — real data we must not touch. */
async function countForeignOutstanding(client: ServiceClient): Promise<number> {
  const { count, error } = await client
    .from("digest")
    .select("id", { count: "exact", head: true })
    .lt("window_start", TEST_WINDOW_FIRST)
    .in("status", ["ready_for_selection", "ready_for_approval"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

let db: ServiceClient;
// Evaluated once, before the suite is defined, so the "nothing outstanding" test can opt out
// cleanly rather than acting on real data.
const foreignOutstanding = configured ? await countForeignOutstanding(serviceClient()) : 0;

describe.skipIf(!configured)("findOutstandingGates (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeTestDigests();
  });
  afterAll(purgeTestDigests);

  it.skipIf(foreignOutstanding > 0)("finds nothing when no digest is outstanding", async () => {
    const result = unwrap(await findOutstandingGates(db));

    expect(result).toEqual([]);
  });

  it("names a digest awaiting selection", async () => {
    const digest = unwrap(await createDigest(db, nextWindow()));
    unwrap(await transitionDigest(db, digest.id, "ranking"));
    unwrap(await transitionDigest(db, digest.id, "ready_for_selection"));

    const result = unwrap(await findOutstandingGates(db));

    const found = result.find((g) => g.digest.id === digest.id);
    expect(found?.gate).toBe("selection");
  });

  it("names a digest awaiting approval", async () => {
    const digest = unwrap(await createDigest(db, nextWindow()));
    for (const status of ["ranking", "ready_for_selection", "generating", "rendering", "ready_for_approval"] as const) {
      unwrap(await transitionDigest(db, digest.id, status));
    }

    const result = unwrap(await findOutstandingGates(db));

    const found = result.find((g) => g.digest.id === digest.id);
    expect(found?.gate).toBe("approval");
  });

  it("excludes digests at any other stage, including terminal ones", async () => {
    const collecting = unwrap(await createDigest(db, nextWindow()));

    const generating = unwrap(await createDigest(db, nextWindow()));
    unwrap(await transitionDigest(db, generating.id, "ranking"));
    unwrap(await transitionDigest(db, generating.id, "ready_for_selection"));
    unwrap(await transitionDigest(db, generating.id, "generating"));

    const published = unwrap(await createDigest(db, nextWindow()));
    unwrap(await transitionDigest(db, published.id, "failed", { lastError: "test" }));

    const result = unwrap(await findOutstandingGates(db));

    const ids = result.map((g) => g.digest.id);
    expect(ids).not.toContain(collecting.id);
    expect(ids).not.toContain(generating.id);
    expect(ids).not.toContain(published.id);
  });

  it("orders the oldest outstanding week first", async () => {
    // nextWindow() guarantees a strictly later window_start on each call, the same technique
    // src/worker/rank.test.ts's "defaults to the newest digest" test relies on.
    const older = unwrap(await createDigest(db, nextWindow()));
    unwrap(await transitionDigest(db, older.id, "ranking"));
    unwrap(await transitionDigest(db, older.id, "ready_for_selection"));

    const newer = unwrap(await createDigest(db, nextWindow()));
    unwrap(await transitionDigest(db, newer.id, "ranking"));
    unwrap(await transitionDigest(db, newer.id, "ready_for_selection"));

    const result = unwrap(await findOutstandingGates(db));

    const olderIndex = result.findIndex((g) => g.digest.id === older.id);
    const newerIndex = result.findIndex((g) => g.digest.id === newer.id);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeLessThan(newerIndex);
  });
});
