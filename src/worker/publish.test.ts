// Digest resolution is the part of the entrypoint worth testing: getting it wrong re-publishes the
// wrong week, or publishes a digest the operator has not approved (mirrors worker/visuals.test.ts).
//
// parseDigestFlag, summarize and buildPublishers need no database and always run.
// resolveTargetDigest hits the real digest/selection/publication tables, behind the same
// SUPABASE_TEST_PROJECT opt-in as the others.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { WorkerEnv } from "@/worker/env";
import { buildPublishers, parseDigestFlag, PublishRefused, resolveTargetDigest, summarize } from "@/worker/publish";
import type { DigestRun, DigestStatus, PublishSummary, RunStateResult, SelectionPlatform } from "@/types";

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

describe("summarize", () => {
  const outcomes: PublishSummary = [
    { platform: "instagram", ok: true, postId: "ig-1" },
    { platform: "facebook", ok: false, error: "rate limited" },
  ];

  it("names each platform's outcome, in the order attempted", () => {
    const lines = summarize(outcomes).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("instagram");
    expect(lines[0]).toContain("ig-1");
    expect(lines[1]).toContain("facebook");
    expect(lines[1]).toContain("rate limited");
  });

  it("returns an empty string for no outcomes", () => {
    expect(summarize([])).toBe("");
  });
});

describe("buildPublishers", () => {
  const env = (over: Partial<WorkerEnv>): WorkerEnv => ({ ...over }) as WorkerEnv;

  it("builds nothing when no credentials are configured", () => {
    expect(buildPublishers(env({}))).toEqual({});
  });

  it("builds Instagram and Facebook from the same shared Meta access token", () => {
    const publishers = buildPublishers(
      env({ META_ACCESS_TOKEN: "token", META_IG_USER_ID: "ig-1", META_PAGE_ID: "page-1" }),
    );

    expect(publishers.instagram).toBeDefined();
    expect(publishers.facebook).toBeDefined();
    expect(publishers.linkedin).toBeUndefined();
  });

  it("omits Instagram when only its own id is missing, even with a shared token present", () => {
    const publishers = buildPublishers(env({ META_ACCESS_TOKEN: "token", META_PAGE_ID: "page-1" }));

    expect(publishers.instagram).toBeUndefined();
    expect(publishers.facebook).toBeDefined();
  });

  it("builds LinkedIn independently of the Meta credentials", () => {
    const publishers = buildPublishers(
      env({ LINKEDIN_ACCESS_TOKEN: "token", LINKEDIN_ORGANIZATION_URN: "urn:li:organization:1" }),
    );

    expect(publishers.linkedin).toBeDefined();
    expect(publishers.instagram).toBeUndefined();
    expect(publishers.facebook).toBeUndefined();
  });
});

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks in 3005: its own year, distinct from every other suite's synthetic range. */
const SYNTHETIC_FIRST = "3005-01-01";
const SYNTHETIC_LAST = "3005-12-31";

let weekIndex = 0;

function nextWeek(): { start: string; end: string } {
  const offset = weekIndex * 7;
  weekIndex += 1;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(new Date(Date.UTC(3005, 0, 5 + offset))),
    end: iso(new Date(Date.UTC(3005, 0, 11 + offset))),
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

/** Any digest outside the synthetic range currently `approved`/`skipped` with something pending — data we must not touch. */
async function foreignApprovedOrSkippedCount(): Promise<number> {
  const { count, error } = await serviceClient()
    .from("digest")
    .select("id", { count: "exact", head: true })
    .lt("window_start", SYNTHETIC_FIRST)
    .in("status", ["approved", "skipped"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

const foreignApprovedOrSkipped = configured ? await foreignApprovedOrSkippedCount() : 0;

let db: ServiceClient;

/** Walk a fresh digest to the given status, with a selection carrying the given platforms. */
async function digestAt(
  status: "approved" | "skipped",
  platforms: SelectionPlatform[] = ["instagram"],
): Promise<DigestRun> {
  const created = unwrap(await createDigest(db, nextWeek()));
  const path: DigestStatus[] = ["ranking", "ready_for_selection", "generating", "rendering", "ready_for_approval"];
  for (const step of path) unwrap(await transitionDigest(db, created.id, step));
  const digest = unwrap(await transitionDigest(db, created.id, status));

  if (platforms.length > 0) {
    const { error } = await db.from("selection").insert({ digest_id: digest.id, format: "single_post", platforms });
    if (error) throw new Error(`failed to insert test selection: ${error.message}`);
  }

  return digest;
}

describe.skipIf(!configured)("resolveTargetDigest (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeSynthetic();
  });
  afterAll(purgeSynthetic);

  it.skipIf(foreignApprovedOrSkipped > 0)(
    "refuses when nothing is approved/skipped with a pending platform",
    async () => {
      await expect(resolveTargetDigest(db, null)).rejects.toThrow(PublishRefused);
      await expect(resolveTargetDigest(db, null)).rejects.toThrow(/has a platform still pending/);
    },
  );

  it("defaults to the newest approved/skipped digest with a pending platform", async () => {
    const older = await digestAt("approved");
    const newer = await digestAt("skipped");

    const digest = await resolveTargetDigest(db, null);

    expect(digest.id).toBe(newer.id);
    expect(digest.window_start > older.window_start).toBe(true);
  });

  // A digest with no confirmed selection has nothing pending -- the default must look past it to
  // an older digest that does, rather than stopping at the newest candidate unconditionally.
  it("skips a newer candidate with no confirmed selection in favor of an older one that has one", async () => {
    const older = await digestAt("approved", ["instagram"]);
    await digestAt("skipped", []); // no selection at all -- nothing pending

    const digest = await resolveTargetDigest(db, null);

    expect(digest.id).toBe(older.id);
  });

  it("honours an explicit --digest over the newest-eligible default", async () => {
    const wanted = await digestAt("approved");
    await digestAt("skipped"); // newer, but --digest must not win over the explicit id

    const digest = await resolveTargetDigest(db, wanted.id);

    expect(digest.id).toBe(wanted.id);
  });

  // A later platform catching up after an earlier partial failure -- record_publication itself
  // allows this, so the worker entrypoint must too.
  it("accepts an explicit --digest already published", async () => {
    const created = unwrap(await createDigest(db, nextWeek()));
    const path: DigestStatus[] = [
      "ranking",
      "ready_for_selection",
      "generating",
      "rendering",
      "ready_for_approval",
      "approved",
      "published",
    ];
    let digest: DigestRun = created;
    for (const step of path) digest = unwrap(await transitionDigest(db, digest.id, step));

    const resolved = await resolveTargetDigest(db, digest.id);

    expect(resolved.id).toBe(digest.id);
  });

  it("refuses an explicit --digest not yet approved", async () => {
    const created = unwrap(await createDigest(db, nextWeek()));
    unwrap(await transitionDigest(db, created.id, "ranking"));

    await expect(resolveTargetDigest(db, created.id)).rejects.toThrow(PublishRefused);
    await expect(resolveTargetDigest(db, created.id)).rejects.toThrow(/not approved, skipped, or published/);
  });
});
