// WORKER-SIDE, but pure: no network, no credentials, no clock. This module is the single
// definition of the contract between the operator's design work in Google Slides and the code that
// fills it. `context/foundation/slides-template-spec.md` is the human-facing rendering of exactly
// what is declared here — if the two ever disagree, this file is right and the document is stale.
//
// The whole point of FR-015 is that the operator restyles without a deploy. That only holds if the
// code depends on NAMES and nothing else: not positions, not colours, not fonts, not the order of
// elements on the page. The single-post deck is found by placeholder names; the carousel deck by
// the tags the operator writes in each slide's speaker notes, so photo slides can be added,
// removed or reordered without a code change.
import type { PageElement, Presentation, Slide } from "@/lib/visuals/slides-client";

/** Placeholders on a single-post story slide — one per selected story. */
export const STORY_PLACEHOLDERS = [
  "TITLE",
  "STAT_1_LABEL",
  "STAT_1_VALUE",
  "STAT_2_LABEL",
  "STAT_2_VALUE",
  "STAT_3_LABEL",
  "STAT_3_VALUE",
] as const;

export type StoryPlaceholder = (typeof STORY_PLACEHOLDERS)[number];

/** The placeholder that carries the headline, and so the one the fit step resizes. */
export const TITLE_PLACEHOLDER = "TITLE" satisfies StoryPlaceholder;

/** How a placeholder appears in the deck. Braces, no spaces: `{{TITLE}}`. */
export function token(placeholder: string): string {
  return `{{${placeholder}}}`;
}

/** Matches any `{{...}}` token, so unknown ones can be reported rather than silently ignored. */
const TOKEN_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * Templates are designed at 1080x1080 px. Slides stores page size in EMU; at 96 DPI one pixel is
 * 9525 EMU, so 1080 px is 10,287,000 EMU. Entering "1080 px" or "810 pt" in Slides' page setup
 * both land here.
 */
export const TARGET_PAGE_EMU = 1080 * 9525;

/**
 * The carousel deck is portrait 4:5 — Instagram's tallest feed format, which Facebook and LinkedIn
 * also show uncropped. 1080 x 1350 px.
 */
export const CAROUSEL_PAGE_EMU = { width: 1080 * 9525, height: 1350 * 9525 } as const;

/** Page-size tolerance. Generous on purpose: aspect ratio is what platforms care about, not exact EMU. */
const PAGE_SIZE_TOLERANCE = 0.02;

/** Which slides a deck must have, and what belongs on each. */
export interface DeckSpec {
  /** Exact number of slides the deck must contain. */
  slideCount: number;
  /** Required placeholders per slide, indexed by slide position. */
  slides: readonly (readonly string[])[];
}

export const DECK_SPECS = {
  // One slide, rendered once per selected story.
  single_post: {
    slideCount: 1,
    slides: [STORY_PLACEHOLDERS],
  },
} as const satisfies Record<string, DeckSpec>;

/** The two decks: positional single-post (`DECK_SPECS`) and the tag-based carousel. */
export type DeckKind = keyof typeof DECK_SPECS | "carousel";

/**
 * The carousel deck's visual sections. Every story slide belongs to exactly one; a week's
 * stories are spread across them for variety.
 */
export const CAROUSEL_SECTIONS = ["barcelona", "spain", "finance_law"] as const;
export type CarouselSection = (typeof CAROUSEL_SECTIONS)[number];

/**
 * Placeholders on a carousel story slide. They share ONE text box, title paragraph first: Slides
 * resets a box's "resize to fit" whenever the API replaces its text, so two stacked boxes would
 * overlap as soon as a headline wrapped. In one box the description simply flows under the title.
 */
export const CAROUSEL_STORY_PLACEHOLDERS = ["TITLE", "DESCRIPTION"] as const;
export const DESCRIPTION_PLACEHOLDER = "DESCRIPTION" satisfies (typeof CAROUSEL_STORY_PLACEHOLDERS)[number];

/** What a carousel slide's speaker notes declare it to be. */
export type SlideTag = { role: "cover" } | { role: "story"; section: CarouselSection };

/**
 * Read a slide's tag from its speaker notes: whitespace-separated `key=value` pairs, any order,
 * e.g. `role=story section=barcelona`. Strict about values — a typo'd section would otherwise
 * silently drop a whole set of photos from rotation.
 */
export function parseSlideTag(notes: string): { ok: true; data: SlideTag } | { ok: false; message: string } {
  const pairs = new Map<string, string>();
  for (const part of notes.trim().split(/\s+/)) {
    const [key, value] = part.split("=");
    if (key && value) pairs.set(key.toLowerCase(), value.toLowerCase());
  }

  const role = pairs.get("role");
  if (!role) return { ok: false, message: "has no `role=` tag in its speaker notes" };
  if (role === "cover") return { ok: true, data: { role: "cover" } };
  if (role !== "story") return { ok: false, message: `has an unknown role "${role}" (expected cover or story)` };

  const section = pairs.get("section");
  if (!section) return { ok: false, message: "is a story slide with no `section=` tag" };
  if (!(CAROUSEL_SECTIONS as readonly string[]).includes(section)) {
    return {
      ok: false,
      message: `has an unknown section "${section}" (expected one of ${CAROUSEL_SECTIONS.join(", ")})`,
    };
  }
  return { ok: true, data: { role: "story", section: section as CarouselSection } };
}

/** The text of a slide's speaker notes, or "" when it has none. */
export function speakerNotes(slide: Slide): string {
  const notesPage = slide.slideProperties?.notesPage;
  const id = notesPage?.notesProperties?.speakerNotesObjectId;
  const shape = notesPage?.pageElements?.find((element) => element.objectId === id);
  return shape ? elementText(shape) : "";
}

/** All the text on one page element, joined. Slides splits a run at every style change. */
export function elementText(element: PageElement): string {
  const runs = element.shape?.text?.textElements ?? [];
  return runs.map((run) => run.textRun?.content ?? "").join("");
}

/** Every `{{TOKEN}}` name appearing in a string, in order, including repeats. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(TOKEN_PATTERN)].map((match) => match[1]);
}

/** One thing wrong with a deck. `fatal` decides the validator's exit code. */
export interface DeckProblem {
  fatal: boolean;
  message: string;
}

export interface DeckReport {
  kind: DeckKind;
  presentationId: string;
  problems: DeckProblem[];
}

export function isDeckValid(report: DeckReport): boolean {
  return !report.problems.some((problem) => problem.fatal);
}

function checkPageSize(presentation: Presentation): DeckProblem[] {
  const width = presentation.pageSize?.width?.magnitude;
  const height = presentation.pageSize?.height?.magnitude;
  if (typeof width !== "number" || typeof height !== "number") {
    return [{ fatal: false, message: "could not read the deck's page size; skipping the size check" }];
  }

  const problems: DeckProblem[] = [];
  // Non-square is FATAL: the whole per-platform story rests on one square asset serving Instagram,
  // LinkedIn and Facebook alike. A 16:9 deck (Slides' default) would silently produce letterboxed
  // posts on every platform.
  if (Math.abs(width - height) > width * PAGE_SIZE_TOLERANCE) {
    problems.push({
      fatal: true,
      message:
        `page is not square (${Math.round(width)} x ${Math.round(height)} EMU). ` +
        `Set File > Page setup > Custom to 1080 x 1080 px.`,
    });
  }
  // Wrong-but-square is a WARNING: it still renders correctly, just not at the intended density.
  if (Math.abs(width - TARGET_PAGE_EMU) > TARGET_PAGE_EMU * PAGE_SIZE_TOLERANCE) {
    problems.push({
      fatal: false,
      message:
        `page is square but not 1080 px (${Math.round(width / 9525)} px). ` +
        `This still renders; it is only a density difference.`,
    });
  }
  return problems;
}

function checkSlide(slide: Slide, index: number, required: readonly string[]): DeckProblem[] {
  const problems: DeckProblem[] = [];
  const elements = slide.pageElements ?? [];
  const requiredSet = new Set<string>(required);

  // Count every occurrence across the page, and remember which element each came from so a
  // placeholder sharing a text box can be named precisely.
  const occurrences = new Map<string, number>();
  for (const element of elements) {
    const found = placeholdersIn(elementText(element));
    for (const name of found) occurrences.set(name, (occurrences.get(name) ?? 0) + 1);

    // Each placeholder needs its own text box. `replaceAllText` would cope with two in one box,
    // but the fit step resizes the TITLE element wholesale — anything sharing that box would be
    // resized with it, which is a silent layout bug rather than a loud failure.
    if (found.length > 1) {
      problems.push({
        fatal: true,
        message: `slide ${index + 1}: one text box holds several placeholders (${found.map(token).join(" ")}). Give each its own text box.`,
      });
    }
  }

  for (const name of required) {
    const count = occurrences.get(name) ?? 0;
    if (count === 0) {
      problems.push({ fatal: true, message: `slide ${index + 1}: missing ${token(name)}` });
    } else if (count > 1) {
      problems.push({
        fatal: true,
        message: `slide ${index + 1}: ${token(name)} appears ${count} times; it must appear exactly once`,
      });
    }
  }

  for (const name of occurrences.keys()) {
    if (!requiredSet.has(name)) {
      problems.push({
        fatal: true,
        message: `slide ${index + 1}: unrecognised placeholder ${token(name)} — check the spelling against the template spec`,
      });
    }
  }

  return problems;
}

function checkPortraitPage(presentation: Presentation): DeckProblem[] {
  const width = presentation.pageSize?.width?.magnitude;
  const height = presentation.pageSize?.height?.magnitude;
  if (typeof width !== "number" || typeof height !== "number") {
    return [{ fatal: false, message: "could not read the deck's page size; skipping the size check" }];
  }

  const target = CAROUSEL_PAGE_EMU.width / CAROUSEL_PAGE_EMU.height;
  const problems: DeckProblem[] = [];
  if (Math.abs(width / height - target) > target * PAGE_SIZE_TOLERANCE) {
    problems.push({
      fatal: true,
      message:
        `page is not 4:5 portrait (${String(Math.round(width / 9525))} x ${String(Math.round(height / 9525))} px). ` +
        `Set File > Page setup > Custom to 1080 x 1350 px.`,
    });
  } else if (Math.abs(width - CAROUSEL_PAGE_EMU.width) > CAROUSEL_PAGE_EMU.width * PAGE_SIZE_TOLERANCE) {
    problems.push({
      fatal: false,
      message:
        `page is 4:5 but not 1080 px wide (${String(Math.round(width / 9525))} px). ` +
        `This still renders; it is only a density difference.`,
    });
  }
  return problems;
}

/** One carousel story slide the renderer may duplicate. */
export interface CarouselStorySlide {
  slide: Slide;
  section: CarouselSection;
  /** The text box holding `{{TITLE}}` then `{{DESCRIPTION}}` — the one the renderer sizes. */
  boxElementId: string;
  /**
   * Where each token starts in the box's text, in UTF-16 code units (the Slides API's index unit).
   * The renderer derives each paragraph's range after replacement from these.
   */
  titleOffset: number;
  descriptionOffset: number;
}

/** The carousel deck as the renderer sees it, plus everything wrong with it. */
export interface CarouselDeck {
  cover: Slide | null;
  /** Usable story slides, in deck order. Slides with problems are left out. */
  stories: CarouselStorySlide[];
  problems: DeckProblem[];
}

/**
 * The story slide's single text box: both carousel placeholders, title first, nothing else in it.
 * "Nothing else" because the renderer sizes the box's paragraphs by character offsets — a stray
 * label typed into the same box would shift them.
 */
function checkStoryBox(
  slide: Slide,
  label: string,
): { box: Omit<CarouselStorySlide, "slide" | "section"> | null; problems: DeckProblem[] } {
  const problems: DeckProblem[] = [];
  const counts = new Map<string, number>();
  let box: Omit<CarouselStorySlide, "slide" | "section"> | null = null;
  let boxReported = false;

  for (const element of slide.pageElements ?? []) {
    const text = elementText(element);
    const found = placeholdersIn(text);
    for (const name of found) counts.set(name, (counts.get(name) ?? 0) + 1);

    if (found.includes(TITLE_PLACEHOLDER) || found.includes(DESCRIPTION_PLACEHOLDER)) {
      const expected = CAROUSEL_STORY_PLACEHOLDERS.map(token);
      const rest = text.replace(expected[0], "").replace(expected[1], "").trim();
      if (found.join(" ") !== CAROUSEL_STORY_PLACEHOLDERS.join(" ") || rest !== "") {
        // Once per slide: two separate boxes would otherwise each report the same mistake.
        if (boxReported) continue;
        boxReported = true;
        problems.push({
          fatal: true,
          message:
            `${label}: ${token(TITLE_PLACEHOLDER)} and ${token(DESCRIPTION_PLACEHOLDER)} must share one text box, ` +
            `title first, with nothing else in it (found "${text.trim().slice(0, 80)}")`,
        });
      } else {
        box = {
          boxElementId: element.objectId,
          titleOffset: text.indexOf(expected[0]),
          descriptionOffset: text.indexOf(expected[1]),
        };
      }
    }
  }

  for (const name of CAROUSEL_STORY_PLACEHOLDERS) {
    const count = counts.get(name) ?? 0;
    if (count === 0) problems.push({ fatal: true, message: `${label}: missing ${token(name)}` });
    if (count > 1) {
      problems.push({
        fatal: true,
        message: `${label}: ${token(name)} appears ${String(count)} times; it must appear exactly once`,
      });
    }
  }
  for (const name of counts.keys()) {
    if (!(CAROUSEL_STORY_PLACEHOLDERS as readonly string[]).includes(name)) {
      problems.push({
        fatal: true,
        message: `${label}: unrecognised placeholder ${token(name)} — check the spelling against the template spec`,
      });
    }
  }

  return { box: problems.length === 0 ? box : null, problems };
}

/**
 * Read the tag-based carousel deck: exactly one cover, and story slides in every section.
 *
 * Shared by the validator and the renderer so the two can never disagree about which slide is
 * which. The renderer refuses a deck with any fatal problem rather than rendering around it.
 */
export function readCarouselDeck(slides: Slide[]): CarouselDeck {
  const problems: DeckProblem[] = [];
  const covers: Slide[] = [];
  const stories: CarouselStorySlide[] = [];

  slides.forEach((slide, index) => {
    const label = `slide ${String(index + 1)}`;
    const tag = parseSlideTag(speakerNotes(slide));
    if (!tag.ok) {
      problems.push({ fatal: true, message: `${label} ${tag.message}` });
      return;
    }

    if (tag.data.role === "cover") {
      covers.push(slide);
      const tokens = (slide.pageElements ?? []).flatMap((element) => placeholdersIn(elementText(element)));
      if (tokens.length > 0) {
        problems.push({
          fatal: true,
          message: `${label}: the cover is exported as designed and takes no placeholders (found ${tokens.map(token).join(" ")})`,
        });
      }
      return;
    }

    const checked = checkStoryBox(slide, label);
    problems.push(...checked.problems);
    if (checked.box) stories.push({ slide, section: tag.data.section, ...checked.box });
  });

  if (covers.length !== 1) {
    problems.push({
      fatal: true,
      message: `expected exactly one slide tagged role=cover, found ${String(covers.length)}`,
    });
  }
  for (const section of CAROUSEL_SECTIONS) {
    if (!stories.some((story) => story.section === section)) {
      problems.push({ fatal: true, message: `no usable story slide tagged section=${section}` });
    }
  }

  return { cover: covers.length === 1 ? covers[0] : null, stories, problems };
}

/**
 * Check one deck against its spec.
 *
 * Every fatal problem here is one that would otherwise surface as a broken image in the middle of
 * a pipeline run — a card with `{{TITLE}}` printed across it, or a story silently missing its
 * figures. Catching them at setup time is the entire reason this function exists.
 */
export function validateDeck(kind: DeckKind, presentation: Presentation): DeckReport {
  if (kind === "carousel") {
    const problems = [...checkPortraitPage(presentation), ...readCarouselDeck(presentation.slides).problems];
    return { kind, presentationId: presentation.presentationId, problems };
  }

  const spec: DeckSpec = DECK_SPECS[kind];
  const problems: DeckProblem[] = [...checkPageSize(presentation)];
  const slides = presentation.slides;

  if (slides.length !== spec.slideCount) {
    problems.push({
      fatal: true,
      message: `expected ${spec.slideCount} slide(s), found ${slides.length}`,
    });
  }

  // Check whichever slides do exist, so a deck with the wrong count still gets useful feedback
  // about the slides it has rather than one blunt count error.
  spec.slides.forEach((required, index) => {
    // `.at()` rather than `[index]`: the index type says a slide is always there, but the deck is
    // whatever the operator built, and the count check above has already allowed for it being short.
    const slide = slides.at(index);
    if (!slide) return;
    problems.push(...checkSlide(slide, index, required));
  });

  return { kind, presentationId: presentation.presentationId, problems };
}
