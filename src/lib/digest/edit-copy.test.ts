// storyEditProblem needs no database and always runs; saveCopyEdits round-trips to the real
// database behind the SUPABASE_TEST_PROJECT opt-in.
//
// SAFETY: synthetic weeks live in 2994 and only that range is purged.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { slideText, storyEditProblem } from "@/lib/digest/copy-rules";
import { saveCopyEdits } from "@/lib/digest/edit-copy";
import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { DigestStatus, RunStateResult } from "@/types";

describe("storyEditProblem", () => {
  const ok = { polishTitle: "Barcelona: ceny mieszkań rosną", captionSummary: "Krótki opis historii na slajd." };

  it("accepts text that fits the carousel slide", () => {
    expect(storyEditProblem("carousel", ok)).toBeNull();
  });

  it("refuses an empty title or caption, whitespace included", () => {
    expect(storyEditProblem("carousel", { ...ok, polishTitle: "   " })).toMatch(/title can't be empty/);
    expect(storyEditProblem("carousel", { ...ok, captionSummary: "\n" })).toMatch(/caption can't be empty/);
  });

  it("refuses text the renderer could not fit, at any size", () => {
    expect(storyEditProblem("carousel", { ...ok, captionSummary: "słowo ".repeat(300) })).toMatch(/Too long/);
  });

  it("checks only the title for a single post, whose slide has no caption", () => {
    expect(storyEditProblem("single_post", { ...ok, captionSummary: "słowo ".repeat(300) })).toBeNull();
    expect(storyEditProblem("single_post", { ...ok, polishTitle: "długi tytuł ".repeat(40) })).toMatch(
      /title is too long/,
    );
  });

  it("measures the text as the slide shows it, with whitespace collapsed", () => {
    expect(slideText("  Barcelona:\n\n ceny  ")).toBe("Barcelona: ceny");
  });
});

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result.data;
}

describe.skipIf(!configured)("saveCopyEdits (integration)", () => {
  let db: ServiceClient;
  let weekIndex = 0;

  async function purge() {
    await db.from("digest").delete().gte("window_start", "2994-01-01").lte("window_start", "2994-12-31");
  }

  /** A synthetic week at the approval gate with one generated story. */
  async function weekAtApproval(status: DigestStatus = "ready_for_approval") {
    const start = new Date(Date.UTC(2994, 0, 3) + weekIndex * 7 * 86_400_000);
    weekIndex += 1;
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    let digest = unwrap(
      await createDigest(db, { start: iso(start), end: iso(new Date(start.getTime() + 6 * 86_400_000)) }),
    );
    for (const to of ["ranking", "ready_for_selection", "generating", "rendering", "ready_for_approval"] as const) {
      digest = unwrap(await transitionDigest(db, digest.id, to));
    }
    if (status !== "ready_for_approval") digest = unwrap(await transitionDigest(db, digest.id, status));

    const { data: cluster, error: clusterError } = await db
      .from("cluster")
      .insert({ digest_id: digest.id })
      .select("id")
      .single();
    if (clusterError) throw new Error(clusterError.message);
    const { error: selectionError } = await db
      .from("selection")
      .insert({ digest_id: digest.id, format: "carousel", platforms: ["facebook"] });
    if (selectionError) throw new Error(selectionError.message);
    const { error: copyError } = await db.from("generated_copy").insert({
      digest_id: digest.id,
      cluster_id: cluster.id,
      polish_title: "Stary tytuł",
      caption_summary: "Stary opis.",
      body_copy: "Treść.",
      key_statistics: [],
      source_text_origin: "article",
    });
    if (copyError) throw new Error(copyError.message);
    return { digestId: digest.id, clusterId: cluster.id };
  }

  beforeAll(async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    db = createServiceClient(url, key);
    await purge();
  });
  afterAll(async () => {
    await purge();
  });

  it("saves the edit and sends the week back to have its slides redrawn", async () => {
    const { digestId, clusterId } = await weekAtApproval();

    const result = await saveCopyEdits(db, digestId, [
      { clusterId, polishTitle: "  Nowy tytuł ", captionSummary: "Nowy opis." },
    ]);

    expect(result).toEqual({ ok: true });
    const { data: copy } = await db
      .from("generated_copy")
      .select("polish_title, caption_summary")
      .eq("digest_id", digestId)
      .single();
    const { data: digest } = await db.from("digest").select("status").eq("id", digestId).single();
    expect(copy).toEqual({ polish_title: "Nowy tytuł", caption_summary: "Nowy opis." });
    expect(digest?.status).toBe("rendering");
  });

  it("saves nothing when a story does not fit, and says which", async () => {
    const { digestId, clusterId } = await weekAtApproval();

    const result = await saveCopyEdits(db, digestId, [
      { clusterId, polishTitle: "Tytuł", captionSummary: "słowo ".repeat(300) },
    ]);

    expect(result).toMatchObject({ ok: false, reason: "invalid_copy" });
    expect(result.ok || result.problems?.[clusterId]).toMatch(/Too long/);
    const { data: digest } = await db.from("digest").select("status").eq("id", digestId).single();
    expect(digest?.status).toBe("ready_for_approval");
  });

  it("refuses a story from another week", async () => {
    const { digestId } = await weekAtApproval();
    const other = await weekAtApproval();

    const result = await saveCopyEdits(db, digestId, [
      { clusterId: other.clusterId, polishTitle: "Tytuł", captionSummary: "Opis." },
    ]);

    expect(result).toMatchObject({ ok: false, reason: "invalid_copy" });
  });

  it("refuses an approved week: its text must match the slides that will be posted", async () => {
    const { digestId, clusterId } = await weekAtApproval("approved");

    const result = await saveCopyEdits(db, digestId, [{ clusterId, polishTitle: "Tytuł", captionSummary: "Opis." }]);

    expect(result).toMatchObject({ ok: false, reason: "not_allowed" });
    const { data: copy } = await db.from("generated_copy").select("polish_title").eq("digest_id", digestId).single();
    expect(copy?.polish_title).toBe("Stary tytuł");
  });
});
