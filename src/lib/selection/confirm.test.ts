// Integration tests for the S-04 selection gate. They exercise the real database, because
// everything under test lives in Postgres: the confirm_selection function's validations, its
// all-or-nothing write, the unique constraint that blocks a double confirm, the FK cascade, and
// deny-by-default RLS on the two new tables.
//
// The central claim is atomicity. Every rejection case therefore asserts twice: that the call
// failed with the expected SQLSTATE, AND that the digest is still in `ready_for_selection` with
// no selection row behind it. A validation that rejected but left a half-written selection would
// pass the first assertion and fail the second.
//
// Target: whatever SUPABASE_URL points at, using the service-role key from `.env`. Every row is
// written into synthetic 2999 week windows (a year of its own — the other integration suites use
// 1970, 1971 and 2991-2998) and purged before and after the run, so no real digest is touched.
//
// Running requires an explicit opt-in — SUPABASE_TEST_PROJECT=1 on top of the key — so that
// pointing an RLS-bypassing write suite at a project is always a deliberate act.
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/db/database.types";
import { createDigest, resumeDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { DigestWindow, RunStateResult } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Synthetic weeks live in 2999 so they can never collide with a real digest or another suite. */
const TEST_WINDOW_FIRST = "2999-01-01";
const TEST_WINDOW_LAST = "2999-12-31";

let weekIndex = 0;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A fresh, unused test week. Each test takes its own so the unique index never collides. */
function nextWindow(): DigestWindow {
  const offset = weekIndex * 7;
  weekIndex += 1;
  return {
    start: isoDate(new Date(Date.UTC(2999, 0, 5 + offset))),
    end: isoDate(new Date(Date.UTC(2999, 0, 11 + offset))),
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

async function purgeTestDigests(): Promise<void> {
  const { error } = await serviceClient()
    .from("digest")
    .delete()
    .gte("window_start", TEST_WINDOW_FIRST)
    .lte("window_start", TEST_WINDOW_LAST);
  if (error) throw new Error(`failed to purge test digests: ${error.message}`);
}

let db: ServiceClient;

interface Shortlist {
  digestId: string;
  /** Ranked cluster ids, in rank order. */
  clusterIds: string[];
}

/**
 * A digest parked exactly where the gate opens: `ready_for_selection`, with `size` ranked
 * clusters standing in for the shortlist the operator would see.
 */
async function seedShortlist(size: number): Promise<Shortlist> {
  const digest = unwrap(await createDigest(db, nextWindow()));
  unwrap(await transitionDigest(db, digest.id, "ranking"));
  unwrap(await transitionDigest(db, digest.id, "ready_for_selection"));

  const { data, error } = await db
    .from("cluster")
    .insert(Array.from({ length: size }, (_, i) => ({ digest_id: digest.id, rank: i + 1 })))
    .select("id, rank");
  if (error) throw new Error(`failed to seed clusters: ${error.message}`);

  const clusterIds = [...data].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((c) => c.id);
  return { digestId: digest.id, clusterIds };
}

function confirm(
  shortlist: Shortlist,
  picked: string[],
  overrides: {
    shortlistIds?: string[];
    format?: "single_post" | "carousel";
    platforms?: ("instagram" | "linkedin" | "facebook")[];
  } = {},
) {
  return db.rpc("confirm_selection", {
    p_digest_id: shortlist.digestId,
    p_shortlist_cluster_ids: overrides.shortlistIds ?? shortlist.clusterIds,
    p_picked_cluster_ids: picked,
    p_format: overrides.format ?? "carousel",
    p_platforms: overrides.platforms ?? ["instagram", "linkedin"],
  });
}

/** Asserts nothing was written and the gate is still open — the atomicity half of each rejection. */
async function expectUnchanged(shortlist: Shortlist): Promise<void> {
  expect(unwrap(await resumeDigest(db, shortlist.digestId)).status).toBe("ready_for_selection");

  const { data } = await db.from("selection").select("id").eq("digest_id", shortlist.digestId);
  expect(data).toEqual([]);
}

describe.skipIf(!configured)("confirm_selection (integration)", () => {
  beforeAll(async () => {
    db = serviceClient();
    await purgeTestDigests();
  });
  afterAll(purgeTestDigests);

  describe("the happy path", () => {
    it("writes the selection, labels the whole shortlist, and opens generation", async () => {
      const shortlist = await seedShortlist(15);
      const picked = shortlist.clusterIds.slice(0, 3);

      const { data: selectionId, error } = await confirm(shortlist, picked);
      expect(error).toBeNull();
      expect(selectionId).toBeTruthy();

      const { data: selection } = await db
        .from("selection")
        .select("id, digest_id, format, platforms")
        .eq("digest_id", shortlist.digestId)
        .single();
      expect(selection?.id).toBe(selectionId);
      expect(selection?.format).toBe("carousel");
      expect(selection?.platforms).toEqual(["instagram", "linkedin"]);

      // US-10: every shortlisted story is on record, not just the picks.
      const { data: items } = await db
        .from("selection_item")
        .select("cluster_id, picked")
        .eq("selection_id", selectionId ?? "");
      expect(items).toHaveLength(15);
      expect(items?.filter((i) => i.picked)).toHaveLength(3);
      expect(items?.filter((i) => !i.picked)).toHaveLength(12);
      expect(new Set(items?.filter((i) => i.picked).map((i) => i.cluster_id))).toEqual(new Set(picked));

      expect(unwrap(await resumeDigest(db, shortlist.digestId)).status).toBe("generating");
    });

    it("accepts the boundary pick counts, 2 and 4", async () => {
      for (const count of [2, 4]) {
        const shortlist = await seedShortlist(6);

        const { error } = await confirm(shortlist, shortlist.clusterIds.slice(0, count));

        expect(error).toBeNull();
        const { data: items } = await db
          .from("selection_item")
          .select("picked, selection!inner(digest_id)")
          .eq("selection.digest_id", shortlist.digestId);
        expect(items?.filter((i) => i.picked)).toHaveLength(count);
      }
    });
  });

  describe("pick-count validation (FR-012: 2-4 stories)", () => {
    it("rejects a single pick", async () => {
      const shortlist = await seedShortlist(6);

      const { error } = await confirm(shortlist, shortlist.clusterIds.slice(0, 1));

      expect(error?.code).toBe("SG003");
      await expectUnchanged(shortlist);
    });

    it("rejects an empty selection", async () => {
      const shortlist = await seedShortlist(6);

      const { error } = await confirm(shortlist, []);

      expect(error?.code).toBe("SG003");
      await expectUnchanged(shortlist);
    });

    it("rejects five picks", async () => {
      const shortlist = await seedShortlist(6);

      const { error } = await confirm(shortlist, shortlist.clusterIds.slice(0, 5));

      expect(error?.code).toBe("SG003");
      await expectUnchanged(shortlist);
    });

    it("rejects duplicates rather than counting them as distinct picks", async () => {
      const shortlist = await seedShortlist(6);
      const [first, second] = shortlist.clusterIds;

      const { error } = await confirm(shortlist, [first, first, second]);

      expect(error?.code).toBe("SG003");
      await expectUnchanged(shortlist);
    });

    it("rejects an empty platform list", async () => {
      const shortlist = await seedShortlist(6);

      const { error } = await confirm(shortlist, shortlist.clusterIds.slice(0, 2), { platforms: [] });

      expect(error?.code).toBe("SG003");
      await expectUnchanged(shortlist);
    });
  });

  describe("shortlist validation", () => {
    it("rejects a pick that is not on the supplied shortlist", async () => {
      const shortlist = await seedShortlist(6);
      const other = await seedShortlist(3);

      const { error } = await confirm(shortlist, [shortlist.clusterIds[0], other.clusterIds[0]]);

      expect(error?.code).toBe("SG004");
      await expectUnchanged(shortlist);
    });

    it("rejects a shortlist naming a cluster from another digest", async () => {
      const shortlist = await seedShortlist(6);
      const other = await seedShortlist(3);
      const contaminated = [...shortlist.clusterIds, other.clusterIds[0]];

      const { error } = await confirm(shortlist, shortlist.clusterIds.slice(0, 2), {
        shortlistIds: contaminated,
      });

      expect(error?.code).toBe("SG005");
      await expectUnchanged(shortlist);
    });

    it("rejects a shortlist naming an unranked cluster", async () => {
      const shortlist = await seedShortlist(6);
      const { data: unranked } = await db
        .from("cluster")
        .insert({ digest_id: shortlist.digestId })
        .select("id")
        .single();

      const { error } = await confirm(shortlist, shortlist.clusterIds.slice(0, 2), {
        shortlistIds: [...shortlist.clusterIds, unranked?.id ?? ""],
      });

      expect(error?.code).toBe("SG005");
      await expectUnchanged(shortlist);
    });

    it("rejects an empty shortlist", async () => {
      const shortlist = await seedShortlist(6);

      const { error } = await confirm(shortlist, shortlist.clusterIds.slice(0, 2), { shortlistIds: [] });

      expect(error?.code).toBe("SG005");
      await expectUnchanged(shortlist);
    });
  });

  describe("digest state", () => {
    it("refuses a digest that has not reached the gate", async () => {
      const digest = unwrap(await createDigest(db, nextWindow()));
      unwrap(await transitionDigest(db, digest.id, "ranking"));
      const { data: clusters } = await db
        .from("cluster")
        .insert([
          { digest_id: digest.id, rank: 1 },
          { digest_id: digest.id, rank: 2 },
        ])
        .select("id");
      const clusterIds = (clusters ?? []).map((c) => c.id);

      const { error } = await db.rpc("confirm_selection", {
        p_digest_id: digest.id,
        p_shortlist_cluster_ids: clusterIds,
        p_picked_cluster_ids: clusterIds,
        p_format: "single_post",
        p_platforms: ["facebook"],
      });

      expect(error?.code).toBe("SG002");
      expect(unwrap(await resumeDigest(db, digest.id)).status).toBe("ranking");
    });

    it("refuses an unknown digest id", async () => {
      const { error } = await db.rpc("confirm_selection", {
        p_digest_id: "00000000-0000-0000-0000-000000000000",
        p_shortlist_cluster_ids: [],
        p_picked_cluster_ids: [],
        p_format: "single_post",
        p_platforms: ["facebook"],
      });

      expect(error?.code).toBe("SG001");
    });

    it("refuses a second confirm — the gate has no undo", async () => {
      const shortlist = await seedShortlist(6);
      const { error: first } = await confirm(shortlist, shortlist.clusterIds.slice(0, 2));
      expect(first).toBeNull();

      const { error: second } = await confirm(shortlist, shortlist.clusterIds.slice(2, 4));

      // The status check fires first, so the operator gets the clearer diagnostic; the unique
      // constraint on selection.digest_id is the backstop underneath it.
      expect(second?.code).toBe("SG002");
      const { data: selections } = await db.from("selection").select("id").eq("digest_id", shortlist.digestId);
      expect(selections).toHaveLength(1);
    });
  });

  describe("schema guarantees", () => {
    it("cascades a digest delete through selection to selection_item", async () => {
      const shortlist = await seedShortlist(5);
      const { data: selectionId } = await confirm(shortlist, shortlist.clusterIds.slice(0, 2));

      await db.from("digest").delete().eq("id", shortlist.digestId);

      const { data: selections } = await db.from("selection").select("id").eq("digest_id", shortlist.digestId);
      const { data: items } = await db
        .from("selection_item")
        .select("id")
        .eq("selection_id", selectionId ?? "");
      expect(selections).toEqual([]);
      expect(items).toEqual([]);
    });

    it("denies the anon/publishable key on both tables (RLS deny-by-default)", async () => {
      const anon = createClient<Database>(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_KEY"));

      for (const table of ["selection", "selection_item"] as const) {
        const { data, error } = await anon.from(table).select("id");
        // RLS with no policies yields an empty set; a hard denial is equally acceptable.
        if (error) {
          expect(error.message).toBeTruthy();
        } else {
          expect(data).toEqual([]);
        }
      }
    });
  });
});
