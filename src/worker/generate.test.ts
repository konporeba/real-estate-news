// Digest resolution is the part of the entrypoint worth testing: getting it wrong regenerates the
// wrong week, or re-generates a digest the operator has already approved (mirrors worker/rank.test.ts).
//
// parseDigestFlag and summarize need no database and always run. resolveTargetDigest hits the real
// digest table, behind the same SUPABASE_TEST_PROJECT opt-in as the others.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { GenerateRefused, parseDigestFlag, resolveTargetDigest, summarize, type GeneratedRow } from "@/worker/generate";
import type { DigestRun, RunStateResult } from "@/types";

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

  // Shape is not validated here on purpose: a malformed id is passed through to resumeDigest,
  // which reports Postgres's own uuid error. Rejecting it locally would duplicate that check and
  // give the operator a second, less specific message for the same mistake.
  it("passes a malformed uuid through unchanged", () => {
    expect(parseDigestFlag(["--digest=not-a-uuid"])).toBe("not-a-uuid");
    expect(parseDigestFlag(["--digest="])).toBeNull();
  });
});

describe("summarize", () => {
  const row = (over: Partial<GeneratedRow>): GeneratedRow => ({
    polish_title: "Tytuł",
    source_text_origin: "article",
    source_char_count: 4200,
    key_statistics: [{ label: "Cena", value: "4 500 €/m²" }],
    ...over,
  });

  it("names each story's origin, size and statistic count", () => {
    const line = summarize([row({})]);

    expect(line).toContain("article");
    expect(line).toContain("4200");
    expect(line).toContain("Tytuł");
  });

  // The lede fallback is the visible symptom of a source that has started refusing us, so it must
  // be legible in the operator's summary rather than only in the database.
  it("distinguishes a lede-fallback story", () => {
    const line = summarize([row({ source_text_origin: "lede", polish_title: "Zapasowy" })]);

    expect(line).toContain("lede");
    expect(line).toContain("Zapasowy");
  });

  it("renders an unknown char count without crashing", () => {
    expect(summarize([row({ source_char_count: null })])).toContain("?");
  });

  it("returns an empty string for no rows", () => {
    expect(summarize([])).toBe("");
  });
});

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks in 3002: its own year, and newer than every other suite's synthetic range. */
const SYNTHETIC_FIRST = "3002-01-01";
const SYNTHETIC_LAST = "3002-12-31";

let weekIndex = 0;

function nextWeek(): { start: string; end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(3002, 0, 5 + offset))),
    end: iso(new Date(Date.UTC(3002, 0, 11 + offset))),
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

/** Any digest outside the synthetic range currently in `generating` — data we must not touch. */
async function countForeignInGenerating(): Promise<number> {
  const { count, error } = await serviceClient()
    .from("digest")
    .select("id", { count: "exact", head: true })
    .lt("window_start", SYNTHETIC_FIRST)
    .eq("status", "generating");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// Evaluated once, before the suite is defined, so the "no digest in generating" test can opt out
// cleanly rather than acting on real data.
const foreignInGenerating = configured ? await countForeignInGenerating() : 0;

let db: ServiceClient;

/** Walk a fresh digest all the way to `generating` — the state the S-04 gate leaves it in. */
async function generatingDigest(client: ServiceClient): Promise<DigestRun> {
  const created = unwrap(await createDigest(client, nextWeek()));
  unwrap(await transitionDigest(client, created.id, "ranking"));
  unwrap(await transitionDigest(client, created.id, "ready_for_selection"));
  return unwrap(await transitionDigest(client, created.id, "generating"));
}

describe.skipIf(!configured)("resolveTargetDigest (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeSynthetic();
  });
  afterAll(purgeSynthetic);

  it.skipIf(foreignInGenerating > 0)("refuses when no digest is in generating", async () => {
    await expect(resolveTargetDigest(db, null)).rejects.toThrow(GenerateRefused);
    await expect(resolveTargetDigest(db, null)).rejects.toThrow(/no digest is in "generating"/);
  });

  it("defaults to the newest digest in generating", async () => {
    const older = await generatingDigest(db);
    // A digest still awaiting the selection gate must never be picked over one past it.
    const waiting = unwrap(await createDigest(db, nextWeek()));
    unwrap(await transitionDigest(db, waiting.id, "ranking"));
    unwrap(await transitionDigest(db, waiting.id, "ready_for_selection"));
    const newer = await generatingDigest(db);

    const digest = await resolveTargetDigest(db, null);

    expect(digest.id).toBe(newer.id);
    expect(digest.window_start > older.window_start).toBe(true);
  });

  it("honours an explicit --digest over the newest-in-generating default", async () => {
    const wanted = await generatingDigest(db);
    await generatingDigest(db); // a newer one that --digest must NOT win over

    const digest = await resolveTargetDigest(db, wanted.id);

    expect(digest.id).toBe(wanted.id);
  });

  it("refuses an explicit --digest not in generating", async () => {
    const collecting = unwrap(await createDigest(db, nextWeek()));

    await expect(resolveTargetDigest(db, collecting.id)).rejects.toThrow(GenerateRefused);
    await expect(resolveTargetDigest(db, collecting.id)).rejects.toThrow(/not "generating"/);
  });

  // impl-review F2: a generation failure must be retryable in place, or a single bad figure costs
  // the whole week (re-collect, re-rank, re-translate, re-select). The confirmed selection is what
  // says the failure happened AFTER the S-04 gate.
  it("puts a failed digest with a confirmed selection back into generating", async () => {
    const failed = await generatingDigest(db);
    unwrap(await transitionDigest(db, failed.id, "failed", { lastError: "numeric integrity failed" }));
    const { error } = await db
      .from("selection")
      .insert({ digest_id: failed.id, format: "single_post", platforms: ["instagram"] });
    if (error) throw new Error(error.message);

    const digest = await resolveTargetDigest(db, failed.id);

    expect(digest.id).toBe(failed.id);
    expect(digest.status).toBe("generating");
  });

  // A digest that failed BEFORE the gate never had picks, so there is nothing to regenerate from.
  it("refuses a failed digest that never passed the selection gate", async () => {
    const failed = unwrap(await createDigest(db, nextWeek()));
    unwrap(await transitionDigest(db, failed.id, "failed", { lastError: "empty pool" }));

    await expect(resolveTargetDigest(db, failed.id)).rejects.toThrow(/no confirmed selection/);
  });

  // The far more likely operator mistake than a still-collecting digest: re-running generate on a
  // week already generated. It must refuse rather than silently regenerate approved-adjacent copy.
  it("refuses a digest already past generation", async () => {
    const done = await generatingDigest(db);
    unwrap(await transitionDigest(db, done.id, "ready_for_approval"));

    await expect(resolveTargetDigest(db, done.id)).rejects.toThrow(/is in "ready_for_approval"/);
  });
});
