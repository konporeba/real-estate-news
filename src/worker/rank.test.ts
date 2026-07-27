// Digest resolution is the part of the entrypoint worth testing: getting it wrong ranks the
// wrong week, or corrupts a digest mid-selection by re-ranking it (mirrors worker/collect.test.ts).
//
// parseDigestFlag needs no database and always runs. resolveTargetDigest hits the real digest
// table, behind the same SUPABASE_TEST_PROJECT opt-in as the others.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { parseDigestFlag, RankRefused, resolveTargetDigest } from "@/worker/rank";
import type { RunStateResult } from "@/types";

describe("parseDigestFlag", () => {
  it("reads a well-formed --digest", () => {
    expect(parseDigestFlag(["--digest=abc-123"])).toBe("abc-123");
  });

  it("finds the flag among other arguments", () => {
    expect(parseDigestFlag(["--verbose", "--digest=abc-123", "extra"])).toBe("abc-123");
  });

  it("returns null when absent", () => {
    expect(parseDigestFlag([])).toBeNull();
    expect(parseDigestFlag(["--dry-run"])).toBeNull();
  });
});

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks in 2998: far enough out that "newest in ranking" always finds these first. */
const SYNTHETIC_FIRST = "2998-01-01";
const SYNTHETIC_LAST = "2998-12-31";

let weekIndex = 0;

function nextWeek(): { start: string; end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(2998, 0, 5 + offset))),
    end: iso(new Date(Date.UTC(2998, 0, 11 + offset))),
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

async function purgeSynthetic(): Promise<void> {
  const { error } = await serviceClient()
    .from("digest")
    .delete()
    .gte("window_start", SYNTHETIC_FIRST)
    .lte("window_start", SYNTHETIC_LAST);
  if (error) throw new Error(`failed to purge synthetic digests: ${error.message}`);
}

/** Any digest outside the synthetic range currently in `ranking` — real data we must not touch. */
async function countForeignInRanking(): Promise<number> {
  const { count, error } = await serviceClient()
    .from("digest")
    .select("id", { count: "exact", head: true })
    .lt("window_start", SYNTHETIC_FIRST)
    .eq("status", "ranking");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// Evaluated once, before the suite is defined, so the "no digest in ranking" test can opt out
// cleanly rather than acting on real data.
const foreignInRanking = configured ? await countForeignInRanking() : 0;

let db: ServiceClient;

async function rankingDigest(client: ServiceClient) {
  const created = unwrap(await createDigest(client, nextWeek()));
  return unwrap(await transitionDigest(client, created.id, "ranking"));
}

describe.skipIf(!configured)("resolveTargetDigest (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeSynthetic();
  });
  afterAll(purgeSynthetic);

  it.skipIf(foreignInRanking > 0)("refuses when no digest is in ranking", async () => {
    await expect(resolveTargetDigest(db, null)).rejects.toThrow(RankRefused);
    await expect(resolveTargetDigest(db, null)).rejects.toThrow(/no digest is in "ranking"/);
  });

  it("defaults to the newest digest in ranking", async () => {
    const older = await rankingDigest(db);
    // A collecting digest must never be picked over an in-ranking one.
    await createDigest(db, nextWeek());
    const newer = await rankingDigest(db);

    const digest = await resolveTargetDigest(db, null);

    expect(digest.id).toBe(newer.id);
    expect(digest.window_start > older.window_start).toBe(true);
  });

  it("honours an explicit --digest over the newest-in-ranking default", async () => {
    const wanted = await rankingDigest(db);
    await rankingDigest(db); // a newer one that --digest must NOT win over

    const digest = await resolveTargetDigest(db, wanted.id);

    expect(digest.id).toBe(wanted.id);
  });

  it("refuses an explicit --digest not in ranking", async () => {
    const collecting = unwrap(await createDigest(db, nextWeek()));

    await expect(resolveTargetDigest(db, collecting.id)).rejects.toThrow(RankRefused);
    await expect(resolveTargetDigest(db, collecting.id)).rejects.toThrow(/not "ranking"/);
  });
});
