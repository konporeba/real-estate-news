// The rendering stage end to end, against the real database with a fake Slides deck and a fake
// asset store. Same shape as generate.test.ts, and the weight sits in the same place: the failure
// branches. Two impl-reviews on this project have now found real bugs in error handling that the
// happy path never touches.
//
// What is deliberately NOT faked is Postgres — the state transitions, the FK from
// `generated_asset` to `cluster`, and the `unique (digest_id, slide_index)` constraint are the
// parts most likely to disagree with the TypeScript, so they are exercised for real.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import type { Presentation, SlidesRequest, SlidesResult, SlidesTransport } from "@/lib/visuals/slides-client";
import { buildPageRequests, type PagePlan, RENDER_PAGE_PREFIX, renderDigest } from "@/lib/visuals/render";
import { COVER_PLACEHOLDERS, STORY_PLACEHOLDERS } from "@/lib/visuals/slots";
import type { AssetStore } from "@/lib/visuals/store";
import { token } from "@/lib/visuals/template";
import type { DigestRun, DigestWindow, RunStateResult, SelectionFormat } from "@/types";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/** Year 3100, its own window so this suite never collides with generate.test.ts's year 3000. */
const TEST_WINDOW_FIRST = "3100-01-01";
const TEST_WINDOW_LAST = "3100-12-31";

const SINGLE_DECK = "deck-single";
const CAROUSEL_DECK = "deck-carousel";
const DECKS = { single_post: SINGLE_DECK, carousel: CAROUSEL_DECK };

let weekIndex = 0;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextWindow(): DigestWindow {
  const offset = weekIndex * 7;
  weekIndex += 1;
  return {
    start: isoDate(new Date(Date.UTC(3100, 0, 4 + offset))),
    end: isoDate(new Date(Date.UTC(3100, 0, 10 + offset))),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the integration suite`);
  return value;
}

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.data;
}

// --- fakes -----------------------------------------------------------------------------------

/**
 * The 24 bytes `pngDimensions` reads: signature, chunk length, IHDR, width, height. Enough to be
 * a real PNG header, which is exactly what the stage checks before storing anything.
 */
function png(width = 1600, height = 1600): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

const textBox = (text: string, objectId: string) => ({
  objectId,
  shape: { text: { textElements: [{ textRun: { content: text } }] } },
});

const storySlide = (objectId: string) => ({
  objectId,
  pageElements: STORY_PLACEHOLDERS.map((name) => textBox(token(name), `${objectId}-${name}`)),
});

const coverSlide = (objectId: string) => ({
  objectId,
  pageElements: COVER_PLACEHOLDERS.map((name) => textBox(token(name), `${objectId}-${name}`)),
});

function deck(format: SelectionFormat, extraSlides: Presentation["slides"] = []): Presentation {
  const slides = format === "carousel" ? [coverSlide("tplCover"), storySlide("tplStory")] : [storySlide("tplStory")];
  return { presentationId: DECKS[format], slides: [...slides, ...extraSlides] };
}

interface SlidesHooks {
  /** Outcome for the nth batch containing a duplicateObject; undefined means "succeed". */
  fill?: (attempt: number) => SlidesResult<void> | undefined;
  /** Outcome for the nth thumbnail export; undefined means "return a valid PNG". */
  thumbnail?: (attempt: number) => SlidesResult<Uint8Array> | undefined;
  /** Make every deleteObject batch fail, to prove cleanup is best-effort and not load-bearing. */
  deleteFails?: boolean;
}

interface FakeSlides {
  transport: SlidesTransport;
  batches: SlidesRequest[][];
  duplicatedPageIds(): string[];
  deletedObjectIds(): string[];
  requestsOn(pageId: string): SlidesRequest[];
}

function fakeSlides(presentation: Presentation, hooks: SlidesHooks = {}): FakeSlides {
  const batches: SlidesRequest[][] = [];
  let fills = 0;
  let thumbnails = 0;

  const has = (request: SlidesRequest, key: string) => Object.hasOwn(request, key);
  const field = (request: SlidesRequest, key: string): Record<string, unknown> =>
    (request[key] ?? {}) as Record<string, unknown>;

  const transport: SlidesTransport = {
    getPresentation: () => Promise.resolve({ ok: true, data: presentation }),

    batchUpdate: (_presentationId, requests) => {
      batches.push(requests);
      if (requests.some((request) => has(request, "duplicateObject"))) {
        fills += 1;
        const outcome = hooks.fill?.(fills);
        if (outcome) return Promise.resolve(outcome);
      }
      if (hooks.deleteFails && requests.some((request) => has(request, "deleteObject"))) {
        return Promise.resolve({ ok: false, reason: "api_error", message: "delete refused" });
      }
      return Promise.resolve({ ok: true, data: undefined });
    },

    getPageThumbnail: () => {
      thumbnails += 1;
      return Promise.resolve(hooks.thumbnail?.(thumbnails) ?? { ok: true, data: png() });
    },
  };

  return {
    transport,
    batches,
    duplicatedPageIds() {
      return batches.flat().flatMap((request) => {
        if (!has(request, "duplicateObject")) return [];
        const duplicate = field(request, "duplicateObject");
        const objectIds = (duplicate.objectIds ?? {}) as Record<string, string>;
        const source = duplicate.objectId as string;
        const target = objectIds[source];
        return target ? [target] : [];
      });
    },
    deletedObjectIds() {
      return batches
        .flat()
        .filter((request) => has(request, "deleteObject"))
        .map((request) => field(request, "deleteObject").objectId as string);
    },
    requestsOn(pageId) {
      return batches.flat().filter((request) => {
        const replace = field(request, "replaceAllText");
        const pages = (replace.pageObjectIds ?? []) as string[];
        const duplicate = field(request, "duplicateObject");
        const objectIds = (duplicate.objectIds ?? {}) as Record<string, string>;
        return pages.includes(pageId) || Object.values(objectIds).includes(pageId);
      });
    },
  };
}

function fakeStore(options: { failing?: boolean } = {}): AssetStore & { uploads: string[] } {
  const uploads: string[] = [];
  return {
    bucket: "digest-assets",
    uploads,
    upload(path) {
      if (options.failing) return Promise.resolve({ ok: false, message: `storage upload to ${path} failed: down` });
      uploads.push(path);
      return Promise.resolve({ ok: true, data: undefined });
    },
  };
}

// --- seeding ---------------------------------------------------------------------------------

let db: ServiceClient;

async function purge(): Promise<void> {
  const { error } = await db
    .from("digest")
    .delete()
    .gte("window_start", TEST_WINDOW_FIRST)
    .lte("window_start", TEST_WINDOW_LAST);
  if (error) throw new Error(`failed to purge test digests: ${error.message}`);
}

interface SeedOptions {
  /** Statistics per story. Below three, the slot map cannot fill the template. */
  statistics?: number;
  titles?: string[];
}

/** A digest in `rendering` with `stories` generated_copy rows, ranked in insertion order. */
async function seedRenderingDigest(
  format: SelectionFormat,
  stories: number,
  options: SeedOptions = {},
): Promise<DigestRun> {
  const digest = unwrap(await createDigest(db, nextWindow()));
  unwrap(await transitionDigest(db, digest.id, "ranking"));
  unwrap(await transitionDigest(db, digest.id, "ready_for_selection"));

  // One insert, not one per cluster: every round trip here is ~a second against the remote test
  // project, and this helper runs in all seventeen cases below.
  const { data: clusters, error: clusterError } = await db
    .from("cluster")
    .insert(Array.from({ length: stories }, (_, i) => ({ digest_id: digest.id, rank: i + 1, coverage_count: 1 })))
    .select("id, rank");
  if (clusterError) throw new Error(clusterError.message);
  const clusterIds = [...clusters].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).map((cluster) => cluster.id);

  const { data: selection, error: selectionError } = await db
    .from("selection")
    .insert({ digest_id: digest.id, format, platforms: ["instagram"] })
    .select("id")
    .single();
  if (selectionError) throw new Error(selectionError.message);

  if (clusterIds.length > 0) {
    const { error: itemError } = await db
      .from("selection_item")
      .insert(clusterIds.map((id) => ({ selection_id: selection.id, cluster_id: id, picked: true })));
    if (itemError) throw new Error(itemError.message);

    const statistics = options.statistics ?? 3;
    const { error: copyError } = await db.from("generated_copy").insert(
      clusterIds.map((clusterId, i) => ({
        digest_id: digest.id,
        cluster_id: clusterId,
        polish_title: options.titles?.[i] ?? `Ceny mieszkań rosną w regionie ${String(i + 1)}`,
        caption_summary: "Podsumowanie tygodnia.",
        body_copy: "Treść posta.",
        key_statistics: Array.from({ length: statistics }, (_, s) => ({
          label: `Etykieta ${String(s + 1)}`,
          value: `${String(s + 1)}%`,
        })),
        source_text_origin: "article",
        source_char_count: 4200,
      })),
    );
    if (copyError) throw new Error(copyError.message);
  }

  unwrap(await transitionDigest(db, digest.id, "generating"));
  return unwrap(await transitionDigest(db, digest.id, "rendering"));
}

async function assetRows(digestId: string) {
  const { data, error } = await db
    .from("generated_asset")
    .select("slide_index, cluster_id, storage_path, width, height, format")
    .eq("digest_id", digestId)
    .order("slide_index", { ascending: true });
  if (error) throw new Error(error.message);
  return data;
}

async function statusOf(digestId: string): Promise<{ status: string; last_error: string | null }> {
  const { data, error } = await db.from("digest").select("status, last_error").eq("id", digestId).single();
  if (error) throw new Error(error.message);
  return data;
}

// --- pure request building -------------------------------------------------------------------

describe("buildPageRequests", () => {
  const plan: PagePlan = {
    slideIndex: 1,
    clusterId: "cluster-1",
    templatePageId: "tplStory",
    templateTitleElementId: "tplStory-TITLE",
    titlePointSize: 36,
    slots: { TITLE: "Ceny rosną", STAT_1_LABEL: "Wzrost", STAT_1_VALUE: "8,3%" },
  };

  it("duplicates the template and names both the page and the title box", () => {
    const requests = buildPageRequests(plan, "renderx1p", "renderx1t");
    expect(requests[0]).toEqual({
      duplicateObject: {
        objectId: "tplStory",
        objectIds: { tplStory: "renderx1p", "tplStory-TITLE": "renderx1t" },
      },
    });
  });

  // The ordering rule from the plan: the size is applied while the box still holds {{TITLE}}.
  it("styles the title before substituting any text", () => {
    const requests = buildPageRequests(plan, "renderx1p", "renderx1t");
    const styleAt = requests.findIndex((request) => Object.hasOwn(request, "updateTextStyle"));
    const firstReplaceAt = requests.findIndex((request) => Object.hasOwn(request, "replaceAllText"));
    expect(styleAt).toBeGreaterThan(-1);
    expect(styleAt).toBeLessThan(firstReplaceAt);
  });

  it("applies the fitted size in points to the duplicated title box", () => {
    const requests = buildPageRequests(plan, "renderx1p", "renderx1t");
    expect(requests[1]).toEqual({
      updateTextStyle: {
        objectId: "renderx1t",
        textRange: { type: "ALL" },
        style: { fontSize: { magnitude: 36, unit: "PT" } },
        fields: "fontSize",
      },
    });
  });

  // Without the scope, one story's replacement would rewrite every other story's card.
  it("scopes every replacement to the page it just created", () => {
    const requests = buildPageRequests(plan, "renderx1p", "renderx1t");
    const replacements = requests.filter((request) => Object.hasOwn(request, "replaceAllText"));
    expect(replacements).toHaveLength(3);
    for (const request of replacements) {
      const replace = request.replaceAllText as { pageObjectIds: string[]; containsText: { text: string } };
      expect(replace.pageObjectIds).toEqual(["renderx1p"]);
      expect(replace.containsText.text).toMatch(/^\{\{[A-Z0-9_]+\}\}$/);
    }
  });

  it("omits the style request on a cover page, which has no headline to fit", () => {
    const cover: PagePlan = {
      slideIndex: 0,
      clusterId: null,
      templatePageId: "tplCover",
      templateTitleElementId: null,
      titlePointSize: null,
      slots: { COVER_TITLE: "Rynek", COVER_SUBTITLE: "1–7 września 2026" },
    };
    const requests = buildPageRequests(cover, "renderx0p", "renderx0t");
    expect(requests.some((request) => Object.hasOwn(request, "updateTextStyle"))).toBe(false);
  });
});

// --- the stage -------------------------------------------------------------------------------

// 40s rather than the 20s default in vitest.config.ts: every case here seeds a digest (nine
// round trips) before the stage makes seven of its own, and against the remote test project that
// lands close enough to 20s to flake.
describe.skipIf(!configured)(
  "renderDigest (integration)",
  () => {
    beforeAll(async () => {
      db = createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
      await purge();
    });
    afterAll(purge);

    it("renders one page per story for a single post and opens the approval gate", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const slides = fakeSlides(deck("single_post"));
      const store = fakeStore();

      const result = await renderDigest(slides.transport, store, db, digest, { decks: DECKS });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.assetCount).toBe(2);
      expect(result.data.digest.status).toBe("ready_for_approval");
      expect(result.data.digest.rendering_completed_at).not.toBeNull();

      const rows = await assetRows(digest.id);
      expect(rows.map((row) => row.slide_index)).toEqual([0, 1]);
      expect(rows.every((row) => row.cluster_id !== null)).toBe(true);
      expect(rows[0].format).toBe("single_post");
      expect(rows[0].width).toBe(1600);
      expect(rows[0].height).toBe(1600);
      expect(store.uploads).toEqual([`${digest.id}/0.png`, `${digest.id}/1.png`]);
    });

    it("renders a cover plus one page per story for a carousel", async () => {
      const digest = await seedRenderingDigest("carousel", 2);
      const slides = fakeSlides(deck("carousel"));

      const result = await renderDigest(slides.transport, fakeStore(), db, digest, { decks: DECKS });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.assetCount).toBe(3);

      const rows = await assetRows(digest.id);
      expect(rows.map((row) => row.slide_index)).toEqual([0, 1, 2]);
      // The cover represents the week, so it belongs to no story.
      expect(rows[0].cluster_id).toBeNull();
      expect(rows[1].cluster_id).not.toBeNull();
      // Slide 0 comes from the cover template, slides 1+ from the story template.
      const coverRequests = slides.requestsOn("renderx0p");
      const coverTokens = coverRequests
        .filter((request) => Object.hasOwn(request, "replaceAllText"))
        .map((request) => (request.replaceAllText as { containsText: { text: string } }).containsText.text);
      expect(coverTokens.sort()).toEqual([...COVER_PLACEHOLDERS].map(token).sort());
    });

    it("re-runs over a previous run's rows rather than colliding with them", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const first = await renderDigest(fakeSlides(deck("single_post")).transport, fakeStore(), db, digest, {
        decks: DECKS,
      });
      expect(first.ok).toBe(true);

      // Back to `rendering` the way FR-018's retry path does, then render again.
      const reset = unwrap(await transitionDigest(db, digest.id, "failed", { lastError: "forced" }));
      expect(reset.status).toBe("failed");
      const retried = unwrap(await transitionDigest(db, digest.id, "rendering"));

      const second = await renderDigest(fakeSlides(deck("single_post")).transport, fakeStore(), db, retried, {
        decks: DECKS,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error(second.message);
      expect(second.data.assetCount).toBe(2);
      expect(await assetRows(digest.id)).toHaveLength(2);
    });

    it("retries a page once and completes when the second attempt succeeds", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const slides = fakeSlides(deck("single_post"), {
        thumbnail: (attempt) => (attempt === 1 ? { ok: false, reason: "api_error", message: "500" } : undefined),
      });

      const result = await renderDigest(slides.transport, fakeStore(), db, digest, { decks: DECKS });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.assetCount).toBe(2);
      expect((await statusOf(digest.id)).status).toBe("ready_for_approval");
    });

    // impl-review F1: a fill batch that fails may still have created the page server-side (the
    // response can be lost after the write). The page must therefore be tracked optimistically, or
    // the retry collides on a duplicate id and the sweep leaves it in the operator's deck.
    it("clears the page id before retrying a fill that failed", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const slides = fakeSlides(deck("single_post"), {
        fill: (attempt) => (attempt === 1 ? { ok: false, reason: "api_error", message: "500" } : undefined),
      });

      const result = await renderDigest(slides.transport, fakeStore(), db, digest, { decks: DECKS });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("ready_for_approval");
      // The failed attempt's page id is deleted before the retry duplicates it again.
      const firstDelete = slides.batches.findIndex((requests) =>
        requests.some((request) => Object.hasOwn(request, "deleteObject")),
      );
      const secondFill = slides.batches.reduce<number[]>(
        (acc, requests, index) =>
          requests.some((request) => Object.hasOwn(request, "duplicateObject")) ? [...acc, index] : acc,
        [],
      );
      expect(firstDelete).toBeGreaterThan(-1);
      expect(secondFill[1]).toBeGreaterThan(firstDelete);
    });

    it("fails the digest when a page fails twice, and persists nothing", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const slides = fakeSlides(deck("single_post"), {
        thumbnail: () => ({ ok: false, reason: "api_error", message: "500" }),
      });

      const result = await renderDigest(slides.transport, fakeStore(), db, digest, { decks: DECKS });

      // A genuine failure: the stage ran to completion and concluded the digest cannot proceed.
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("failed");
      expect(result.data.assetCount).toBe(0);
      expect(result.data.digest.last_error).toContain("after a retry");
      expect(await assetRows(digest.id)).toHaveLength(0);
    });

    it("deletes every duplicated page on the success path", async () => {
      const digest = await seedRenderingDigest("carousel", 2);
      const slides = fakeSlides(deck("carousel"));

      await renderDigest(slides.transport, fakeStore(), db, digest, { decks: DECKS });

      const duplicated = slides.duplicatedPageIds();
      expect(duplicated).toHaveLength(3);
      for (const pageId of duplicated) expect(slides.deletedObjectIds()).toContain(pageId);
    });

    it("deletes every duplicated page on the failure path too", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const slides = fakeSlides(deck("single_post"), {
        thumbnail: () => ({ ok: false, reason: "api_error", message: "500" }),
      });

      await renderDigest(slides.transport, fakeStore(), db, digest, { decks: DECKS });

      const duplicated = slides.duplicatedPageIds();
      expect(duplicated.length).toBeGreaterThan(0);
      for (const pageId of duplicated) expect(slides.deletedObjectIds()).toContain(pageId);
    });

    // A crashed run cannot clean up after itself; the next one must, or the leftovers shift every
    // template index and get exported as this week's cards.
    it("sweeps a previous run's leftover pages before reading the templates", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const stale = `${RENDER_PAGE_PREFIX}9p`;
      const slides = fakeSlides(deck("single_post", [storySlide(stale)]));

      const result = await renderDigest(slides.transport, fakeStore(), db, digest, { decks: DECKS });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("ready_for_approval");
      expect(slides.deletedObjectIds()).toContain(stale);
    });

    it("still succeeds when cleanup itself fails — the next run's sweep collects the pages", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const slides = fakeSlides(deck("single_post"), { deleteFails: true });

      const result = await renderDigest(slides.transport, fakeStore(), db, digest, { decks: DECKS });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("ready_for_approval");
    });

    it("fails with a diagnostic when there is too little generated copy, rather than throwing", async () => {
      const digest = await seedRenderingDigest("single_post", 1);

      const result = await renderDigest(fakeSlides(deck("single_post")).transport, fakeStore(), db, digest, {
        decks: DECKS,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("failed");
      expect(result.data.digest.last_error).toContain("generated copy row");
    });

    it("fails with a diagnostic when a story has too few statistics to fill the template", async () => {
      const digest = await seedRenderingDigest("single_post", 2, { statistics: 2 });

      const result = await renderDigest(fakeSlides(deck("single_post")).transport, fakeStore(), db, digest, {
        decks: DECKS,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("failed");
      expect(result.data.digest.last_error).toContain("insufficient_statistics");
    });

    it("fails with a diagnostic when a headline is past the last fit tier", async () => {
      const digest = await seedRenderingDigest("single_post", 2, { titles: ["a".repeat(400), "Krótki tytuł"] });

      const result = await renderDigest(fakeSlides(deck("single_post")).transport, fakeStore(), db, digest, {
        decks: DECKS,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("failed");
      expect(result.data.digest.last_error).toContain("title_too_long");
    });

    // Nothing is duplicated when the content cannot render: the plan is built before the first call.
    it("touches the deck at all only after every content decision is settled", async () => {
      const digest = await seedRenderingDigest("single_post", 2, { statistics: 2 });
      const slides = fakeSlides(deck("single_post"));

      await renderDigest(slides.transport, fakeStore(), db, digest, { decks: DECKS });

      expect(slides.duplicatedPageIds()).toHaveLength(0);
    });

    it("fails with a diagnostic when the deck has no title box", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const titleless: Presentation = {
        presentationId: SINGLE_DECK,
        slides: [{ objectId: "tplStory", pageElements: [textBox("no placeholders here", "el-1")] }],
      };

      const result = await renderDigest(fakeSlides(titleless).transport, fakeStore(), db, digest, { decks: DECKS });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("failed");
      expect(result.data.digest.last_error).toContain("visuals:validate");
    });

    it("fails the digest when the Slides client is not configured", async () => {
      const digest = await seedRenderingDigest("single_post", 2);

      const result = await renderDigest(null, fakeStore(), db, digest, { decks: DECKS });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("failed");
      expect(result.data.digest.last_error).toContain("GOOGLE_SA_EMAIL");
    });

    it("fails the digest when no deck is configured for the chosen format", async () => {
      const digest = await seedRenderingDigest("carousel", 2);

      const result = await renderDigest(fakeSlides(deck("carousel")).transport, fakeStore(), db, digest, {
        decks: { single_post: SINGLE_DECK },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.data.digest.status).toBe("failed");
      expect(result.data.digest.last_error).toContain("carousel");
    });

    // Storage being down is infrastructure, not a verdict on the digest: it stays in `rendering` so
    // re-running the stage is the entire recovery, rather than needing a failed -> rendering hop.
    it("returns a storage outage raw and leaves the digest in rendering", async () => {
      const digest = await seedRenderingDigest("single_post", 2);
      const slides = fakeSlides(deck("single_post"));

      const result = await renderDigest(slides.transport, fakeStore({ failing: true }), db, digest, { decks: DECKS });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a raw infrastructure failure");
      // impl-review F2: distinguishable from a Postgres failure by reason, not only by message.
      expect(result.reason).toBe("storage_error");
      expect(result.message).toContain("storage upload");
      expect((await statusOf(digest.id)).status).toBe("rendering");
      // The deck is still left clean, even though the run did not finish.
      for (const pageId of slides.duplicatedPageIds()) expect(slides.deletedObjectIds()).toContain(pageId);
    });
  },
  40_000,
);
