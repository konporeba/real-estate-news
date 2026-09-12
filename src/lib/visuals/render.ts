// WORKER-SIDE. The rendering stage: everything between "a digest exists in `rendering`" and "the
// digest is in `ready_for_approval` or `failed`". Composes the slot map and the fit ladder
// (Phase 3) with the Slides transport (Phase 2) and Storage, mirroring `generateDigest()`.
//
// FAILURE POSTURE, matching the convention rankDigest/generateDigest set: an INFRASTRUCTURE
// failure (Postgres, Storage) is returned raw, leaving the digest in `rendering` so re-running
// `npm run visuals` is the whole recovery. A GENUINE failure — no copy to render, a deck that
// does not match template-spec.md, a story with too few figures, a headline past the last fit
// tier, unconfigured Slides credentials — transitions the digest to `failed` with a diagnostic
// and still returns `ok: true`: the stage ran to completion and concluded the digest cannot
// proceed. Callers tell the two apart by `outcome.data.digest.status`.
//
// THE DECK IS SHARED MUTABLE STATE. The operator may have it open while this runs. Nothing here
// ever edits a template slide: every page is duplicated, filled, exported and deleted. Deleting
// happens as soon as the bytes are in hand — before the upload, so a Storage outage still leaves
// the deck clean — with a `finally` sweep behind it and a prefix sweep on the next start, because
// a crashed process cannot run either.
import { markStageComplete, transitionDigest } from "@/lib/digest/run-state";
// MIN_PICKS rather than a literal 2: FR-012's bound has one definition, and the copy rows this
// stage renders are downstream of exactly that rule.
import { MIN_PICKS } from "@/lib/selection/rules";
import type { ServiceClient } from "@/lib/supabase-service";
import { fitTitle } from "@/lib/visuals/fit";
import type { Presentation, Slide, SlidesRequest, SlidesTransport } from "@/lib/visuals/slides-client";
import { buildCoverSlots, buildSlotMap } from "@/lib/visuals/slots";
import type { AssetStore } from "@/lib/visuals/store";
import { assetPath, pngDimensions } from "@/lib/visuals/store";
import { elementText, placeholdersIn, TITLE_PLACEHOLDER, token } from "@/lib/visuals/template";
import type { DigestRun, GeneratedCopyRow, RunStateResult, SelectionFormat } from "@/types";

/**
 * Object-id prefix for every page this stage creates.
 *
 * Slides ids are caller-chosen, so the duplicates are named rather than discovered. That is what
 * makes a crashed run's leftovers identifiable on the next start instead of accumulating silently
 * in a deck the operator also edits by hand. Distinctive enough that nothing Slides generates
 * (`g1a2b3...`, `p3`, `SLIDES_API...`) or a human types collides with it.
 */
export const RENDER_PAGE_PREFIX = "renderx";

const renderPageId = (slideIndex: number) => `${RENDER_PAGE_PREFIX}${String(slideIndex)}p`;
const renderTitleId = (slideIndex: number) => `${RENDER_PAGE_PREFIX}${String(slideIndex)}t`;

export interface RenderOptions {
  /** Presentation id per format; the stage uses the one the operator's selection asked for. */
  decks: Partial<Record<SelectionFormat, string>>;
}

export interface RenderOutcome {
  digest: DigestRun;
  /** Images persisted this run. 0 when the stage concluded in `failed` before persisting. */
  assetCount: number;
}

/** A stage-internal problem with a human-readable explanation, not a state-machine failure. */
interface Failure {
  ok: false;
  message: string;
}

type Resolved<T> = { ok: true; data: T } | Failure;

function databaseFail(error: { code: string; message: string }): RunStateResult<never> {
  return { ok: false, reason: "database_error", message: `${error.code}: ${error.message}` };
}

/** The genuine-failure path: transition to `failed` with a diagnostic, but return `ok: true`. */
async function failDigest(
  client: ServiceClient,
  digestId: string,
  message: string,
): Promise<RunStateResult<RenderOutcome>> {
  const failed = await transitionDigest(client, digestId, "failed", { lastError: message });
  if (!failed.ok) return failed;
  return { ok: true, data: { digest: failed.data, assetCount: 0 } };
}

interface RenderInput {
  /** null when the operator never confirmed a selection for this digest. */
  format: SelectionFormat | null;
  /** One row per selected story, in the order the operator saw them on the shortlist. */
  copies: GeneratedCopyRow[];
}

/**
 * Read the format and the generated copy.
 *
 * Ordered by the cluster's shortlist RANK, not by insertion: `slide_index` is the carousel's
 * reading order, and the operator's mental model of "the week's stories" is the order the
 * dashboard showed them in. Insertion order would be whatever the generation loop happened to do.
 */
async function fetchRenderInput(client: ServiceClient, digestId: string): Promise<RunStateResult<RenderInput>> {
  const { data: selection, error: selectionError } = await client
    .from("selection")
    .select("format")
    .eq("digest_id", digestId)
    .maybeSingle();
  if (selectionError) return databaseFail(selectionError);
  if (!selection) return { ok: true, data: { format: null, copies: [] } };

  const { data: copies, error: copyError } = await client.from("generated_copy").select("*").eq("digest_id", digestId);
  if (copyError) return databaseFail(copyError);
  if (copies.length === 0) return { ok: true, data: { format: selection.format, copies: [] } };

  const { data: clusters, error: clusterError } = await client
    .from("cluster")
    .select("id, rank")
    .in(
      "id",
      copies.map((copy) => copy.cluster_id),
    );
  if (clusterError) return databaseFail(clusterError);

  // A cluster with no rank sorts last rather than crashing the sort: rank is set by the ranking
  // stage and a copy row cannot exist without one, but a missing value must not lose the digest.
  const rankOf = new Map(clusters.map((cluster) => [cluster.id, cluster.rank ?? Number.MAX_SAFE_INTEGER]));
  const ordered = [...copies].sort(
    (a, b) =>
      (rankOf.get(a.cluster_id) ?? Number.MAX_SAFE_INTEGER) - (rankOf.get(b.cluster_id) ?? Number.MAX_SAFE_INTEGER),
  );

  return { ok: true, data: { format: selection.format, copies: ordered } };
}

/** Pages this stage left behind — a crashed run's, or an interrupted one's. */
function leftoverPageIds(presentation: Presentation): string[] {
  return presentation.slides.filter((slide) => slide.objectId.startsWith(RENDER_PAGE_PREFIX)).map((s) => s.objectId);
}

/** The operator's own slides, with any of our leftovers filtered out so indexes stay meaningful. */
function templateSlides(presentation: Presentation): Slide[] {
  return presentation.slides.filter((slide) => !slide.objectId.startsWith(RENDER_PAGE_PREFIX));
}

function deleteObjectRequests(objectIds: string[]): SlidesRequest[] {
  return objectIds.map((objectId) => ({ deleteObject: { objectId } }));
}

/** The id of the text box carrying a given placeholder, or null if the deck has no such box. */
function findPlaceholderElement(slide: Slide, placeholder: string): string | null {
  for (const element of slide.pageElements ?? []) {
    if (placeholdersIn(elementText(element)).includes(placeholder)) return element.objectId;
  }
  return null;
}

interface DeckTemplates {
  /** The page duplicated once per story. */
  storyPageId: string;
  /**
   * The `{{TITLE}}` box on that page. Resolved HERE, before any replacement: after
   * `replaceAllText` the box holds a Polish headline, which is not a stable way to find it again.
   */
  titleElementId: string;
  /** Carousel only: the page duplicated once, as slide 0. */
  coverPageId: string | null;
}

/**
 * Locate the template pages by position, per `DECK_SPECS`: a single-post deck is one story slide;
 * a carousel deck is a cover followed by the story slide.
 *
 * Every failure here points at `npm run visuals:validate`, which is the tool that exists precisely
 * so this is caught at setup time rather than mid-pipeline.
 */
function resolveTemplates(slides: Slide[], format: SelectionFormat): Resolved<DeckTemplates> {
  const storySlide = format === "carousel" ? slides.at(1) : slides.at(0);
  const coverSlide = format === "carousel" ? slides.at(0) : null;

  if (format === "carousel" && !coverSlide) {
    return { ok: false, message: "the carousel deck has no cover slide; run `npm run visuals:validate`" };
  }
  if (!storySlide) {
    return {
      ok: false,
      message: `the ${format} deck has no story slide at the expected position; run \`npm run visuals:validate\``,
    };
  }

  const titleElementId = findPlaceholderElement(storySlide, TITLE_PLACEHOLDER);
  if (!titleElementId) {
    return {
      ok: false,
      message: `the story slide has no ${token(TITLE_PLACEHOLDER)} text box; run \`npm run visuals:validate\``,
    };
  }

  return {
    ok: true,
    data: { storyPageId: storySlide.objectId, titleElementId, coverPageId: coverSlide?.objectId ?? null },
  };
}

export interface PagePlan {
  slideIndex: number;
  /** null on a carousel cover: it represents the week, not a story. */
  clusterId: string | null;
  templatePageId: string;
  /** null on a cover, which carries no headline to fit. */
  templateTitleElementId: string | null;
  titlePointSize: number | null;
  slots: Record<string, string>;
}

/**
 * Turn the copy rows into one plan per page, resolving every content decision up front.
 *
 * Deliberately ahead of the first API call: a story with too few figures or an unfittable headline
 * is a certainty, not a transient, and discovering it on page 3 would mean three duplicated pages
 * and three uploads already spent on a digest that cannot finish.
 */
function buildPagePlans(
  format: SelectionFormat,
  digest: DigestRun,
  copies: GeneratedCopyRow[],
  templates: DeckTemplates,
): Resolved<PagePlan[]> {
  const plans: PagePlan[] = [];

  if (format === "carousel" && templates.coverPageId) {
    plans.push({
      slideIndex: 0,
      clusterId: null,
      templatePageId: templates.coverPageId,
      templateTitleElementId: null,
      titlePointSize: null,
      slots: buildCoverSlots(digest),
    });
  }

  for (const copy of copies) {
    const slots = buildSlotMap(copy);
    if (!slots.ok) {
      return { ok: false, message: `"${copy.polish_title}": ${slots.reason} — ${slots.message}` };
    }
    const size = fitTitle(copy.polish_title);
    if (!size.ok) {
      return { ok: false, message: `"${copy.polish_title}": ${size.reason} — ${size.message}` };
    }

    plans.push({
      slideIndex: plans.length,
      clusterId: copy.cluster_id,
      templatePageId: templates.storyPageId,
      templateTitleElementId: templates.titleElementId,
      titlePointSize: size.data,
      slots: slots.data,
    });
  }

  return { ok: true, data: plans };
}

/**
 * One page's edits, as a single batch.
 *
 * The duplicate names both the new page AND the new title box, so the style request that follows
 * can address a box that did not exist when the batch was built — the alternative is re-reading
 * the whole presentation after every duplication.
 *
 * Font size is applied BEFORE the text is substituted, per the stage's ordering rule.
 */
export function buildPageRequests(plan: PagePlan, pageId: string, titleId: string): SlidesRequest[] {
  const objectIds: Record<string, string> = { [plan.templatePageId]: pageId };
  if (plan.templateTitleElementId) objectIds[plan.templateTitleElementId] = titleId;

  const requests: SlidesRequest[] = [{ duplicateObject: { objectId: plan.templatePageId, objectIds } }];

  if (plan.templateTitleElementId && plan.titlePointSize !== null) {
    requests.push({
      updateTextStyle: {
        objectId: titleId,
        textRange: { type: "ALL" },
        style: { fontSize: { magnitude: plan.titlePointSize, unit: "PT" } },
        fields: "fontSize",
      },
    });
  }

  for (const [name, value] of Object.entries(plan.slots)) {
    requests.push({
      replaceAllText: {
        containsText: { text: token(name), matchCase: true },
        // Scoped to this page, which is the whole reason a multi-story carousel can live in one
        // deck: an unscoped replaceAllText would rewrite every story's card with this one's text.
        pageObjectIds: [pageId],
        replaceText: value,
      },
    });
  }

  return requests;
}

interface RenderedPage {
  slideIndex: number;
  clusterId: string | null;
  storagePath: string;
  width: number;
  height: number;
}

type PageResult = { ok: true; data: RenderedPage } | { ok: false; kind: "slides" | "storage"; message: string };

/**
 * Duplicate, fill, export, delete, upload — one page, one attempt.
 *
 * The page is deleted as soon as the bytes are downloaded and BEFORE the upload: the deck belongs
 * to a human, and a Storage outage should not leave a stray slide in it. `created` tracks pages
 * that exist right now, so the caller's sweep is exact rather than a guess.
 */
async function renderPage(
  slides: SlidesTransport,
  storage: AssetStore,
  deckId: string,
  digestId: string,
  plan: PagePlan,
  created: Set<string>,
): Promise<PageResult> {
  const pageId = renderPageId(plan.slideIndex);
  const titleId = renderTitleId(plan.slideIndex);

  // The ids are deterministic, so a retry after a failed cleanup would collide with its own
  // previous attempt. Clear the way first rather than spending the retry on a duplicate-id error.
  if (created.has(pageId)) {
    const cleared = await slides.batchUpdate(deckId, deleteObjectRequests([pageId]));
    if (cleared.ok) created.delete(pageId);
  }

  // Tracked BEFORE the call, not after. If the duplicate is applied server-side but the response
  // never arrives (connection reset, timeout — both surface here as `api_error`), a page tracked
  // only on success would be invisible to the caller's sweep AND to this function's own pre-delete
  // on the retry, stranding it in the operator's deck and failing the retry on a duplicate id.
  // Deleting a page that was never created is a harmless ignored failure; missing one that was is
  // not, so the optimistic direction is the safe one.
  created.add(pageId);

  const applied = await slides.batchUpdate(deckId, buildPageRequests(plan, pageId, titleId));
  if (!applied.ok) {
    return {
      ok: false,
      kind: "slides",
      message: `slide ${String(plan.slideIndex)}: ${applied.reason}: ${applied.message}`,
    };
  }

  const exported = await slides.getPageThumbnail(deckId, pageId);

  // Unconditional: the bytes (if any) are already in hand, so the page has no further use whether
  // the export worked or not, and a failed attempt must free the id for the retry that follows.
  const removed = await slides.batchUpdate(deckId, deleteObjectRequests([pageId]));
  if (removed.ok) created.delete(pageId);

  if (!exported.ok) {
    return {
      ok: false,
      kind: "slides",
      message: `slide ${String(plan.slideIndex)} export: ${exported.reason}: ${exported.message}`,
    };
  }

  // Also catches an error page served with a 200, which would otherwise be stored as a "card".
  const dimensions = pngDimensions(exported.data);
  if (!dimensions) {
    return { ok: false, kind: "slides", message: `slide ${String(plan.slideIndex)}: the export was not a PNG` };
  }

  const storagePath = assetPath(digestId, plan.slideIndex);
  const uploaded = await storage.upload(storagePath, exported.data);
  if (!uploaded.ok) return { ok: false, kind: "storage", message: uploaded.message };

  return { ok: true, data: { slideIndex: plan.slideIndex, clusterId: plan.clusterId, storagePath, ...dimensions } };
}

/**
 * Re-runs replace rather than resume, the precedent `clearExistingCopy` and `clearExistingClusters`
 * both set. Cleared immediately before the insert so a failed retry cannot destroy a previous
 * good run's images and then produce nothing.
 */
async function persistAssets(
  client: ServiceClient,
  digestId: string,
  format: SelectionFormat,
  pages: RenderedPage[],
): Promise<RunStateResult<void>> {
  const { error: clearError } = await client.from("generated_asset").delete().eq("digest_id", digestId);
  if (clearError) return databaseFail(clearError);

  const { error } = await client.from("generated_asset").insert(
    pages.map((page) => ({
      digest_id: digestId,
      cluster_id: page.clusterId,
      slide_index: page.slideIndex,
      storage_path: page.storagePath,
      width: page.width,
      height: page.height,
      format,
    })),
  );
  if (error) return databaseFail(error);
  return { ok: true, data: undefined };
}

/**
 * Render every slide for a digest that is in `rendering`. Assumes the caller (the worker
 * entrypoint) has already checked the digest's status — the same split `generateDigest` uses.
 *
 * Pages are rendered SEQUENTIALLY. There is no cost ceiling to protect here, but the deck is one
 * shared document and the object ids are deterministic; concurrent batches against the same
 * presentation buy nothing at 3-5 pages and would make a partial failure much harder to reason
 * about.
 */
export async function renderDigest(
  slides: SlidesTransport | null,
  storage: AssetStore,
  client: ServiceClient,
  digest: DigestRun,
  options: RenderOptions,
): Promise<RunStateResult<RenderOutcome>> {
  const input = await fetchRenderInput(client, digest.id);
  if (!input.ok) return input;
  const { format, copies } = input.data;

  if (!format) {
    return failDigest(client, digest.id, "no confirmed selection for this digest; nothing to render");
  }
  if (copies.length < MIN_PICKS) {
    return failDigest(
      client,
      digest.id,
      `only ${String(copies.length)} generated copy row(s) for this digest; the selection gate requires at least ` +
        `${String(MIN_PICKS)}. Re-run \`npm run generate\` before rendering.`,
    );
  }
  if (!slides) {
    return failDigest(
      client,
      digest.id,
      "the Google Slides client is not configured; set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY_B64 (see .env.example)",
    );
  }

  const deckId = options.decks[format];
  if (!deckId) {
    return failDigest(client, digest.id, `no template deck configured for the ${format} format; see .env.example`);
  }

  const presentation = await slides.getPresentation(deckId);
  if (!presentation.ok) {
    return failDigest(
      client,
      digest.id,
      `could not read the ${format} deck: ${presentation.reason}: ${presentation.message}`,
    );
  }

  // Sweep first: a previous crash's leftovers would otherwise shift every template index by one
  // and be exported as this week's cards.
  const leftovers = leftoverPageIds(presentation.data);
  if (leftovers.length > 0) {
    const swept = await slides.batchUpdate(deckId, deleteObjectRequests(leftovers));
    if (!swept.ok) {
      return failDigest(
        client,
        digest.id,
        `could not clear ${String(leftovers.length)} leftover page(s) from the ${format} deck: ${swept.message}`,
      );
    }
  }

  const templates = resolveTemplates(templateSlides(presentation.data), format);
  if (!templates.ok) return failDigest(client, digest.id, templates.message);

  const plans = buildPagePlans(format, digest, copies, templates.data);
  if (!plans.ok) return failDigest(client, digest.id, plans.message);

  const created = new Set<string>();
  const rendered: RenderedPage[] = [];
  let failure: { kind: "slides" | "storage"; message: string } | null = null;

  try {
    for (const plan of plans.data) {
      // Exactly one corrective retry per page, the shape generateStory and clusterArticles share.
      let attempt = await renderPage(slides, storage, deckId, digest.id, plan, created);
      if (!attempt.ok) attempt = await renderPage(slides, storage, deckId, digest.id, plan, created);

      if (!attempt.ok) {
        failure = { kind: attempt.kind, message: attempt.message };
        break;
      }
      rendered.push(attempt.data);
    }
  } finally {
    // Best-effort: whatever survives here is prefixed, so the next run's sweep collects it. The
    // stage's own outcome must not turn on a cleanup call, or a deck left tidy-but-unreachable
    // would mask a run that actually succeeded.
    //
    // One call per page rather than one batch for all of them: batchUpdate is all-or-nothing, so a
    // single id that is already gone (see the optimistic tracking in renderPage) would fail the
    // whole sweep and strand every page that really is still there.
    for (const pageId of created) await slides.batchUpdate(deckId, deleteObjectRequests([pageId]));
  }

  if (failure) {
    // Storage is infrastructure: returned raw, leaving the digest in `rendering` so re-running the
    // stage is the entire recovery. A Slides failure that survived a retry is a real problem with
    // the deck or the credentials, which is the operator's to fix — hence `failed` + diagnostic.
    if (failure.kind === "storage") return { ok: false, reason: "storage_error", message: failure.message };
    return failDigest(client, digest.id, `rendering failed after a retry: ${failure.message}`);
  }

  const persisted = await persistAssets(client, digest.id, format, rendered);
  if (!persisted.ok) return persisted;

  const checkpointed = await markStageComplete(client, digest.id, "rendering");
  if (!checkpointed.ok) return checkpointed;

  const transitioned = await transitionDigest(client, digest.id, "ready_for_approval");
  if (!transitioned.ok) return transitioned;

  return { ok: true, data: { digest: transitioned.data, assetCount: rendered.length } };
}
