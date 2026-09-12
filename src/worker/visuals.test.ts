// Digest resolution is the part of the entrypoint worth testing: getting it wrong re-renders the
// wrong week, or re-renders a digest the operator has already approved (mirrors
// worker/generate.test.ts and worker/rank.test.ts).
//
// parseDigestFlag, summarize and decksFrom need no database and always run. resolveTargetDigest
// hits the real digest table, behind the same SUPABASE_TEST_PROJECT opt-in as the others.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDigest, markStageComplete, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { WorkerEnv } from "@/worker/env";
import {
  type AssetSummaryRow,
  decksFrom,
  parseDigestFlag,
  resolveTargetDigest,
  summarize,
  VisualsRefused,
} from "@/worker/visuals";
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

  // Same reasoning as generate.ts: a malformed id is passed through to resumeDigest, which reports
  // Postgres's own uuid error rather than a second, vaguer message for the same mistake.
  it("passes a malformed uuid through unchanged", () => {
    expect(parseDigestFlag(["--digest=not-a-uuid"])).toBe("not-a-uuid");
    expect(parseDigestFlag(["--digest="])).toBeNull();
  });
});

describe("summarize", () => {
  const row = (over: Partial<AssetSummaryRow> = {}): AssetSummaryRow => ({
    slide_index: 0,
    width: 1600,
    height: 1600,
    storage_path: "digest-1/0.png",
    ...over,
  });

  it("names each slide's index, size and storage path", () => {
    const line = summarize([row()]);

    expect(line).toContain("slide 0");
    expect(line).toContain("1600x1600");
    expect(line).toContain("digest-1/0.png");
  });

  it("lists one line per slide, in the order given", () => {
    const lines = summarize([row(), row({ slide_index: 1, storage_path: "digest-1/1.png" })]).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("slide 0");
    expect(lines[1]).toContain("slide 1");
  });

  it("renders unknown dimensions without crashing", () => {
    expect(summarize([row({ width: null, height: null })])).toContain("?");
  });

  it("returns an empty string for no rows", () => {
    expect(summarize([])).toBe("");
  });
});

describe("decksFrom", () => {
  const env = (over: Partial<WorkerEnv>): WorkerEnv => ({ ...over }) as WorkerEnv;

  it("maps each configured deck onto its format", () => {
    expect(decksFrom(env({ SLIDES_DECK_SINGLE_POST: "s1", SLIDES_DECK_CAROUSEL: "c1" }))).toEqual({
      single_post: "s1",
      carousel: "c1",
    });
  });

  // A half-configured worker is legitimate: the operator may only publish single posts. The
  // orchestrator fails the digest only if the format the selection asked for has no deck.
  it("omits a format with no deck rather than carrying an undefined id", () => {
    expect(decksFrom(env({ SLIDES_DECK_SINGLE_POST: "s1" }))).toEqual({ single_post: "s1" });
  });

  it("returns nothing when neither deck is set", () => {
    expect(decksFrom(env({}))).toEqual({});
  });
});

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks in 3200: its own year, and newer than every other suite's synthetic range. */
const SYNTHETIC_FIRST = "3200-01-01";
const SYNTHETIC_LAST = "3200-12-31";

let weekIndex = 0;

function nextWeek(): { start: string; end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(3200, 0, 6 + offset))),
    end: iso(new Date(Date.UTC(3200, 0, 12 + offset))),
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

/** Any digest outside the synthetic range currently in `rendering` — data we must not touch. */
async function countForeignInRendering(): Promise<number> {
  const { count, error } = await serviceClient()
    .from("digest")
    .select("id", { count: "exact", head: true })
    .lt("window_start", SYNTHETIC_FIRST)
    .eq("status", "rendering");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// Evaluated once, before the suite is defined, so the "no digest in rendering" test can opt out
// cleanly rather than acting on real data.
const foreignInRendering = configured ? await countForeignInRendering() : 0;

let db: ServiceClient;

/** Walk a fresh digest to `rendering` — the state a completed generation leaves it in. */
async function renderingDigest(client: ServiceClient): Promise<DigestRun> {
  const created = unwrap(await createDigest(client, nextWeek()));
  unwrap(await transitionDigest(client, created.id, "ranking"));
  unwrap(await transitionDigest(client, created.id, "ready_for_selection"));
  unwrap(await transitionDigest(client, created.id, "generating"));
  // The checkpoint is what the failed-retry path reads to tell a render failure from an earlier
  // one, so it is stamped here exactly as generateDigest() stamps it.
  unwrap(await markStageComplete(client, created.id, "generation"));
  return unwrap(await transitionDigest(client, created.id, "rendering"));
}

describe.skipIf(!configured)("resolveTargetDigest (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeSynthetic();
  });
  afterAll(purgeSynthetic);

  it.skipIf(foreignInRendering > 0)("refuses when no digest is in rendering", async () => {
    await expect(resolveTargetDigest(db, null)).rejects.toThrow(VisualsRefused);
    await expect(resolveTargetDigest(db, null)).rejects.toThrow(/no digest is in "rendering"/);
  });

  it("defaults to the newest digest in rendering", async () => {
    const older = await renderingDigest(db);
    // A digest still awaiting generation must never be picked over one past it.
    const waiting = unwrap(await createDigest(db, nextWeek()));
    unwrap(await transitionDigest(db, waiting.id, "ranking"));
    unwrap(await transitionDigest(db, waiting.id, "ready_for_selection"));
    const newer = await renderingDigest(db);

    const digest = await resolveTargetDigest(db, null);

    expect(digest.id).toBe(newer.id);
    expect(digest.window_start > older.window_start).toBe(true);
  });

  it("honours an explicit --digest over the newest-in-rendering default", async () => {
    const wanted = await renderingDigest(db);
    await renderingDigest(db); // a newer one that --digest must NOT win over

    const digest = await resolveTargetDigest(db, wanted.id);

    expect(digest.id).toBe(wanted.id);
  });

  it("refuses an explicit --digest not in rendering", async () => {
    const collecting = unwrap(await createDigest(db, nextWeek()));

    await expect(resolveTargetDigest(db, collecting.id)).rejects.toThrow(VisualsRefused);
    await expect(resolveTargetDigest(db, collecting.id)).rejects.toThrow(/not "rendering"/);
  });

  // The likeliest operator mistake: re-running visuals on a week already rendered and awaiting
  // approval. It must refuse rather than silently re-render what the operator is reviewing.
  it("refuses a digest already past rendering", async () => {
    const done = await renderingDigest(db);
    unwrap(await transitionDigest(db, done.id, "ready_for_approval"));

    await expect(resolveTargetDigest(db, done.id)).rejects.toThrow(/is in "ready_for_approval"/);
  });

  // Rendering costs nothing to redo, so a render failure is retried in place rather than by
  // re-running the dollar-sized stages behind it.
  it("puts a digest that failed after generation back into rendering", async () => {
    const failed = await renderingDigest(db);
    unwrap(await transitionDigest(db, failed.id, "failed", { lastError: "the export was not a PNG" }));

    const digest = await resolveTargetDigest(db, failed.id);

    expect(digest.id).toBe(failed.id);
    expect(digest.status).toBe("rendering");
  });

  // A digest that failed BEFORE generation completed has no copy, so there is nothing to render.
  it("refuses a failed digest that never completed generation", async () => {
    const failed = unwrap(await createDigest(db, nextWeek()));
    unwrap(await transitionDigest(db, failed.id, "failed", { lastError: "empty pool" }));

    await expect(resolveTargetDigest(db, failed.id)).rejects.toThrow(/never completed generation/);
  });
});
