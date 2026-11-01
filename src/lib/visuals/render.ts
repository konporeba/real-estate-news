// WORKER-SIDE. The rendering stage: everything between "a digest exists in `rendering`" and "the
// digest is in `ready_for_approval` or `failed`". Composes the slot maps, the fit ladders and
// (carousel) the section/photo choice with the Slides transport and Storage, mirroring
// `generateDigest()`. Single post: one page per story from the deck's one slide. Carousel: the
// tagged cover, then one page per story on a photo slide from its section (sections.ts).
//
// FAILURE POSTURE, matching the convention rankDigest/generateDigest set: an INFRASTRUCTURE
// failure (Postgres, Storage) is returned raw, leaving the digest in `rendering` so re-running
// `npm run visuals` is the whole recovery. A GENUINE failure — no copy to render, a deck that
// does not match the template spec, a single-post story with too few figures, text past the last
// fit tier, unconfigured Slides credentials — transitions the digest to `failed` with a diagnostic
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
import { fitCarouselText, fitTitle } from "@/lib/digest/fit";
import { assignSections, assignSlides, isoWeekNumber, type SectionDetail } from "@/lib/visuals/sections";
import type { Presentation, Slide, SlidesRequest, SlidesTransport } from "@/lib/visuals/slides-client";
import { buildCarouselSlots, buildSlotMap } from "@/lib/visuals/slots";
import type { AssetStore } from "@/lib/visuals/store";
import { assetPath, pngDimensions } from "@/lib/visuals/store";
import {
  type CarouselSection,
  DESCRIPTION_PLACEHOLDER,
  elementText,
  placeholdersIn,
  readCarouselDeck,
  TITLE_PLACEHOLDER,
  token,
} from "@/lib/visuals/template";
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
const renderBoxId = (slideIndex: number) => `${RENDER_PAGE_PREFIX}${String(slideIndex)}t`;

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
  /** Each story's ranking detail by cluster id — what decides its carousel section. */
  details: Map<string, SectionDetail | null>;
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
  if (!selection) return { ok: true, data: { format: null, copies: [], details: new Map() } };

  const { data: copies, error: copyError } = await client.from("generated_copy").select("*").eq("digest_id", digestId);
  if (copyError) return databaseFail(copyError);
  if (copies.length === 0) return { ok: true, data: { format: selection.format, copies: [], details: new Map() } };

  const { data: clusters, error: clusterError } = await client
    .from("cluster")
    .select("id, rank, scoring_detail")
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

  // `scoring_detail` is jsonb written by the ranking stage; only `tier` and `financeLaw` are read,
  // and storySections() treats anything missing as "no information".
  const details = new Map(clusters.map((cluster) => [cluster.id, cluster.scoring_detail as SectionDetail | null]));

  return { ok: true, data: { format: selection.format, copies: ordered, details } };
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

interface SinglePostTemplate {
  /** The page duplicated once per story. */
  storyPageId: string;
  /**
   * The `{{TITLE}}` box on that page. Resolved HERE, before any replacement: after
   * `replaceAllText` the box holds a Polish headline, which is not a stable way to find it again.
   */
  titleElementId: string;
}

/**
 * Locate the single-post template by position, per `DECK_SPECS`: one story slide.
 *
 * Every failure here points at `npm run visuals:validate`, which is the tool that exists precisely
 * so this is caught at setup time rather than mid-pipeline.
 */
function resolveSinglePostTemplate(slides: Slide[]): Resolved<SinglePostTemplate> {
  const storySlide = slides.at(0);
  if (!storySlide) {
    return { ok: false, message: "the single_post deck has no story slide; run `npm run visuals:validate`" };
  }

  const titleElementId = findPlaceholderElement(storySlide, TITLE_PLACEHOLDER);
  if (!titleElementId) {
    return {
      ok: false,
      message: `the story slide has no ${token(TITLE_PLACEHOLDER)} text box; run \`npm run visuals:validate\``,
    };
  }

  return { ok: true, data: { storyPageId: storySlide.objectId, titleElementId } };
}

/** A single-post story page: one box per placeholder, the title sized by the character ladder. */
export interface SinglePostPagePlan {
  kind: "single_post";
  slideIndex: number;
  clusterId: string;
  templatePageId: string;
  templateTitleElementId: string;
  titlePointSize: number;
  slots: Record<string, string>;
}

/** The carousel's cover: exported as designed, never duplicated or filled. */
export interface CoverPagePlan {
  kind: "cover";
  slideIndex: number;
  clusterId: null;
  templatePageId: string;
}

/** A carousel story page: headline and description sharing one box, each paragraph sized. */
export interface CarouselStoryPagePlan {
  kind: "carousel_story";
  slideIndex: number;
  clusterId: string;
  section: CarouselSection;
  templatePageId: string;
  /** The shared box on the template page; the duplicate gets a deterministic id for it. */
  templateBoxElementId: string;
  /** Where `{{TITLE}}` and `{{DESCRIPTION}}` start in the template box, in UTF-16 units. */
  titleOffset: number;
  descriptionOffset: number;
  title: string;
  description: string;
  titlePointSize: number;
  descriptionPointSize: number;
}

export type PagePlan = SinglePostPagePlan | CoverPagePlan | CarouselStoryPagePlan;

/**
 * Turn the copy rows into one plan per page, resolving every content decision up front.
 *
 * Deliberately ahead of the first API call: a story with too few figures or an unfittable headline
 * is a certainty, not a transient, and discovering it on page 3 would mean three duplicated pages
 * and three uploads already spent on a digest that cannot finish.
 */
function buildSinglePostPlans(copies: GeneratedCopyRow[], template: SinglePostTemplate): Resolved<PagePlan[]> {
  const plans: PagePlan[] = [];

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
      kind: "single_post",
      slideIndex: plans.length,
      clusterId: copy.cluster_id,
      templatePageId: template.storyPageId,
      templateTitleElementId: template.titleElementId,
      titlePointSize: size.data,
      slots: slots.data,
    });
  }

  return { ok: true, data: plans };
}

/**
 * The carousel: the cover, then one page per story on a photo slide from the story's section.
 * Same up-front rule as single-post — every text and slide decision is made before the deck is
 * touched.
 */
function buildCarouselPlans(
  slides: Slide[],
  digest: DigestRun,
  copies: GeneratedCopyRow[],
  details: Map<string, SectionDetail | null>,
): Resolved<PagePlan[]> {
  const deck = readCarouselDeck(slides);
  const fatal = deck.problems.find((problem) => problem.fatal);
  if (fatal || !deck.cover) {
    return {
      ok: false,
      message: `the carousel deck does not match the template spec (${fatal?.message ?? "no cover"}); run \`npm run visuals:validate\``,
    };
  }

  const sections = assignSections(copies.map((copy) => details.get(copy.cluster_id) ?? null));
  const photos = assignSlides(sections, deck.stories, isoWeekNumber(digest.window_start));
  const plans: PagePlan[] = [{ kind: "cover", slideIndex: 0, clusterId: null, templatePageId: deck.cover.objectId }];

  for (const [index, copy] of copies.entries()) {
    const slots = buildCarouselSlots(copy);
    if (!slots.ok) {
      return { ok: false, message: `"${copy.polish_title}": ${slots.reason} — ${slots.message}` };
    }
    const size = fitCarouselText(slots.data.TITLE, slots.data.DESCRIPTION);
    if (!size.ok) {
      return { ok: false, message: `"${copy.polish_title}": ${size.reason} — ${size.message}` };
    }
    const photo = photos[index];
    if (!photo) {
      return { ok: false, message: `the carousel deck has no story slide for section ${sections[index]}` };
    }

    plans.push({
      kind: "carousel_story",
      slideIndex: plans.length,
      clusterId: copy.cluster_id,
      section: sections[index],
      templatePageId: photo.slide.objectId,
      templateBoxElementId: photo.boxElementId,
      titleOffset: photo.titleOffset,
      descriptionOffset: photo.descriptionOffset,
      title: slots.data.TITLE,
      description: slots.data.DESCRIPTION,
      titlePointSize: size.data.titlePt,
      descriptionPointSize: size.data.descriptionPt,
    });
  }

  return { ok: true, data: plans };
}

/** Every page this digest needs, in reading order, from the format's deck. */
export function planPages(
  format: SelectionFormat,
  slides: Slide[],
  digest: DigestRun,
  copies: GeneratedCopyRow[],
  details: Map<string, SectionDetail | null>,
): Resolved<PagePlan[]> {
  if (format === "carousel") return buildCarouselPlans(slides, digest, copies, details);

  const template = resolveSinglePostTemplate(slides);
  if (!template.ok) return template;
  return buildSinglePostPlans(copies, template.data);
}

const replaceOnPage = (pageId: string, placeholder: string, value: string): SlidesRequest => ({
  replaceAllText: {
    containsText: { text: token(placeholder), matchCase: true },
    // Scoped to this page, which is the whole reason a multi-story carousel can live in one
    // deck: an unscoped replaceAllText would rewrite every story's card with this one's text.
    pageObjectIds: [pageId],
    replaceText: value,
  },
});

const fontSizeOn = (objectId: string, textRange: Record<string, unknown>, pointSize: number): SlidesRequest => ({
  updateTextStyle: {
    objectId,
    textRange,
    style: { fontSize: { magnitude: pointSize, unit: "PT" } },
    fields: "fontSize",
  },
});

/**
 * One duplicated page's edits, as a single batch.
 *
 * The duplicate names both the new page AND the box that gets sized, so the style request can
 * address a box that did not exist when the batch was built — the alternative is re-reading the
 * whole presentation after every duplication.
 *
 * Single-post: the title's size is applied BEFORE the text is substituted, to the whole box.
 * Carousel: the box holds two paragraphs, so each is sized AFTER substitution, by a fixed range
 * computed from the template offsets and the replacement lengths (UTF-16 units, as Slides counts).
 */
export function buildPageRequests(
  plan: SinglePostPagePlan | CarouselStoryPagePlan,
  pageId: string,
  boxId: string,
): SlidesRequest[] {
  if (plan.kind === "single_post") {
    return [
      {
        duplicateObject: {
          objectId: plan.templatePageId,
          objectIds: { [plan.templatePageId]: pageId, [plan.templateTitleElementId]: boxId },
        },
      },
      fontSizeOn(boxId, { type: "ALL" }, plan.titlePointSize),
      ...Object.entries(plan.slots).map(([name, value]) => replaceOnPage(pageId, name, value)),
    ];
  }

  const titleStart = plan.titleOffset;
  const titleEnd = titleStart + plan.title.length;
  // The description follows the title, so its start moves by however much the title grew.
  const descriptionStart = plan.descriptionOffset - token(TITLE_PLACEHOLDER).length + plan.title.length;
  const descriptionEnd = descriptionStart + plan.description.length;

  return [
    {
      duplicateObject: {
        objectId: plan.templatePageId,
        objectIds: { [plan.templatePageId]: pageId, [plan.templateBoxElementId]: boxId },
      },
    },
    replaceOnPage(pageId, TITLE_PLACEHOLDER, plan.title),
    replaceOnPage(pageId, DESCRIPTION_PLACEHOLDER, plan.description),
    fontSizeOn(boxId, { type: "FIXED_RANGE", startIndex: titleStart, endIndex: titleEnd }, plan.titlePointSize),
    fontSizeOn(
      boxId,
      { type: "FIXED_RANGE", startIndex: descriptionStart, endIndex: descriptionEnd },
      plan.descriptionPointSize,
    ),
  ];
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
 * One page's PNG bytes, one attempt.
 *
 * The cover is exported straight from the operator's slide: nothing on it changes, so there is
 * nothing to duplicate and nothing to clean up. Every other page is duplicated, filled, exported
 * and deleted — deleted as soon as the bytes are downloaded, because the deck belongs to a human.
 * `created` tracks pages that exist right now, so the caller's sweep is exact rather than a guess.
 *
 * Exported for `npm run visuals:preview`, which renders through exactly this path.
 */
export async function exportPage(
  slides: SlidesTransport,
  deckId: string,
  plan: PagePlan,
  created: Set<string>,
): Promise<{ ok: true; data: Uint8Array } | { ok: false; message: string }> {
  if (plan.kind === "cover") {
    const exported = await slides.getPageThumbnail(deckId, plan.templatePageId);
    if (!exported.ok) {
      return { ok: false, message: `slide 0 (cover) export: ${exported.reason}: ${exported.message}` };
    }
    return exported;
  }

  const pageId = renderPageId(plan.slideIndex);
  const boxId = renderBoxId(plan.slideIndex);

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

  const applied = await slides.batchUpdate(deckId, buildPageRequests(plan, pageId, boxId));
  if (!applied.ok) {
    return { ok: false, message: `slide ${String(plan.slideIndex)}: ${applied.reason}: ${applied.message}` };
  }

  const exported = await slides.getPageThumbnail(deckId, pageId);

  // Unconditional: the bytes (if any) are already in hand, so the page has no further use whether
  // the export worked or not, and a failed attempt must free the id for the retry that follows.
  const removed = await slides.batchUpdate(deckId, deleteObjectRequests([pageId]));
  if (removed.ok) created.delete(pageId);

  if (!exported.ok) {
    return { ok: false, message: `slide ${String(plan.slideIndex)} export: ${exported.reason}: ${exported.message}` };
  }
  return exported;
}

/** Export one page, check it is a real PNG, upload it — one attempt. */
async function renderPage(
  slides: SlidesTransport,
  storage: AssetStore,
  deckId: string,
  digestId: string,
  plan: PagePlan,
  created: Set<string>,
): Promise<PageResult> {
  const exported = await exportPage(slides, deckId, plan, created);
  if (!exported.ok) return { ok: false, kind: "slides", message: exported.message };

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

  const plans = planPages(format, templateSlides(presentation.data), digest, copies, input.data.details);
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
