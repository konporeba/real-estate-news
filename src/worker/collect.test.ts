// Week resolution is the part of the entrypoint worth testing: getting it wrong strands a
// failed run and silently creates an empty digest for the wrong week (FR-018).
//
// parseWeekFlag needs no database and always runs. The resolution and preparation suites
// hit the real digest table, behind the same SUPABASE_TEST_PROJECT opt-in as the others.
//
// SAFETY: `resolveTargetDigest`'s default path asks "what is the newest recoverable digest
// ANYWHERE", which is global by nature — so these tests cannot isolate themselves the way
// the other suites do by picking an unused week. Two things keep them from destroying real
// data: synthetic weeks live in the FAR FUTURE (2999) so they always sort newest regardless
// of what real digests exist, and the purge only ever deletes that range. The one test that
// genuinely needs an empty table skips itself instead of clearing one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { CollectRefused, parseWeekFlag, prepareForCollection, resolveTargetDigest } from "@/worker/collect";
import type { DigestRun, RunStateResult } from "@/types";

describe("parseWeekFlag", () => {
  it("reads a well-formed --week", () => {
    expect(parseWeekFlag(["--week=2026-07-20"])).toBe("2026-07-20");
  });

  it("finds the flag among other arguments", () => {
    expect(parseWeekFlag(["--verbose", "--week=2026-07-20", "extra"])).toBe("2026-07-20");
  });

  it("returns null when absent", () => {
    expect(parseWeekFlag([])).toBeNull();
    expect(parseWeekFlag(["--dry-run"])).toBeNull();
  });

  // A malformed date must not be parsed as a date. Returning null means the run targets
  // the default week, which the startup banner prints — so the operator sees that their
  // flag was not honoured rather than silently getting the wrong week.
  it("ignores a malformed --week rather than guessing", () => {
    expect(parseWeekFlag(["--week=july"])).toBeNull();
    expect(parseWeekFlag(["--week=2026-7-2"])).toBeNull();
  });
});

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks in 2999: far enough out that they always sort above any real digest. */
const SYNTHETIC_FIRST = "2999-01-01";
const SYNTHETIC_LAST = "2999-12-31";

let weekIndex = 0;

function nextWeek(): { start: string; end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(2999, 0, 4 + offset))),
    end: iso(new Date(Date.UTC(2999, 0, 10 + offset))),
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

/** Deletes only the synthetic range. Real digests are never in scope. */
async function purgeSynthetic(): Promise<void> {
  const { error } = await serviceClient()
    .from("digest")
    .delete()
    .gte("window_start", SYNTHETIC_FIRST)
    .lte("window_start", SYNTHETIC_LAST);
  if (error) throw new Error(`failed to purge synthetic digests: ${error.message}`);
}

/** Any recoverable digest outside the synthetic range — i.e. real data we must not touch. */
async function countForeignRecoverable(): Promise<number> {
  const { count, error } = await serviceClient()
    .from("digest")
    .select("id", { count: "exact", head: true })
    .lt("window_start", SYNTHETIC_FIRST)
    .not("status", "in", "(published,skipped)");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// Evaluated once, before the suites are defined, so the "empty table" test can opt out
// cleanly rather than deleting whatever it found.
const foreignRecoverable = configured ? await countForeignRecoverable() : 0;

let db: ServiceClient;

describe.skipIf(!configured)("resolveTargetDigest (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeSynthetic();
  });
  afterAll(purgeSynthetic);

  it.skipIf(foreignRecoverable > 0)("creates the current Monday–Sunday week when nothing is recoverable", async () => {
    const now = new Date("2026-06-18T12:00:00Z"); // a Thursday

    const { digest, origin } = await resolveTargetDigest(db, null, now);

    try {
      expect(origin).toBe("created");
      expect(digest.window_start).toBe("2026-06-15"); // the Monday
      expect(digest.window_end).toBe("2026-06-21");
      expect(digest.status).toBe("collecting");
    } finally {
      // Only clean up a digest this test actually created. If resolution returned an
      // existing one, deleting it here would destroy another suite's fixture — or real
      // data. (It did exactly that before `fileParallelism: false`.)
      if (origin === "created") {
        await db.from("digest").delete().eq("id", digest.id);
      }
    }
  });

  // The FR-018 default: an operator noticing Sunday's failure on Tuesday must get the
  // failed run back, not a fresh digest for the wrong week.
  it("recovers a failed digest instead of creating the current week", async () => {
    const week = nextWeek();
    const failed = unwrap(await createDigest(db, week));
    unwrap(await transitionDigest(db, failed.id, "failed", { lastError: "collection produced no articles" }));

    const { digest, origin } = await resolveTargetDigest(db, null, new Date("2026-06-18T12:00:00Z"));

    expect(origin).toBe("recovered");
    expect(digest.id).toBe(failed.id);
    expect(digest.window_start).toBe(week.start);
  });

  it("prefers the newest recoverable digest when several exist", async () => {
    const older = unwrap(await createDigest(db, nextWeek()));
    unwrap(await transitionDigest(db, older.id, "failed", { lastError: "boom" }));
    const newer = unwrap(await createDigest(db, nextWeek()));

    const { digest } = await resolveTargetDigest(db, null, new Date("2026-06-18T12:00:00Z"));

    expect(digest.id).toBe(newer.id);
  });

  it("honours an explicit --week over a recoverable digest from another week", async () => {
    const recoverable = unwrap(await createDigest(db, nextWeek()));
    const wanted = nextWeek();

    const { digest, origin } = await resolveTargetDigest(db, wanted.start);

    expect(origin).toBe("flag");
    expect(digest.id).not.toBe(recoverable.id);
    expect(digest.window_start).toBe(wanted.start);
    expect(digest.window_end).toBe(wanted.end);
  });

  it("reuses the existing digest when --week names one that already exists", async () => {
    const week = nextWeek();
    const existing = unwrap(await createDigest(db, week));

    const { digest } = await resolveTargetDigest(db, week.start);

    expect(digest.id).toBe(existing.id);
  });
});

describe.skipIf(!configured)("prepareForCollection (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeSynthetic();
  });
  afterAll(purgeSynthetic);

  it("passes a collecting digest through untouched", async () => {
    const digest = unwrap(await createDigest(db, nextWeek()));

    const prepared = await prepareForCollection(db, digest);

    expect(prepared.id).toBe(digest.id);
    expect(prepared.status).toBe("collecting");
  });

  it("re-triggers a failed digest back into collecting (FR-018)", async () => {
    const digest = unwrap(await createDigest(db, nextWeek()));
    unwrap(await transitionDigest(db, digest.id, "failed", { lastError: "everything blocked" }));

    const prepared = await prepareForCollection(db, digest);

    expect(prepared.status).toBe("collecting");
    // Re-triggering starts a clean slate, so the stale diagnostic must be gone.
    expect(prepared.last_error).toBeNull();
  });

  it("refuses a digest already past collection rather than corrupting it", async () => {
    const digest = unwrap(await createDigest(db, nextWeek()));
    const ranking: DigestRun = unwrap(await transitionDigest(db, digest.id, "ranking"));

    await expect(prepareForCollection(db, ranking)).rejects.toThrow(CollectRefused);
    await expect(prepareForCollection(db, ranking)).rejects.toThrow(/past collection/);
  });
});
