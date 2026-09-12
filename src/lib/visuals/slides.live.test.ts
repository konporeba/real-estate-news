// LIVE smoke test: one real round trip against the operator's own Google Slides deck. The faked
// transport in render.test.ts proves the stage handles the shapes the Slides types promise; it
// cannot notice a revoked service-account key, a deck that was never shared with the service
// account, a renamed placeholder, or the API's real response drifting from those assumptions —
// the class of failure S-01's live smoke caught within minutes of existing, and the gap S-03 and
// S-05 each had to close after the fact.
//
// Opt-in via SLIDES_LIVE_SMOKE=1 plus GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY_B64 and
// SLIDES_DECK_SINGLE_POST, so CI stays hermetic and a routine `npm test` never touches the deck:
//
//   SLIDES_LIVE_SMOKE=1 npx vitest run src/lib/visuals/slides.live.test.ts
//
// IT MUTATES A DOCUMENT A HUMAN OWNS. The page it adds carries RENDER_PAGE_PREFIX, so even if this
// process dies mid-test the next `npm run visuals` sweeps it; the test still deletes it in a
// `finally`, and asserts afterwards that the TEMPLATE slide is untouched — a regression that
// overwrote the operator's design in place is the worst thing this stage could do, and it is the
// one thing a fake transport can never rule out.
import { afterAll, describe, expect, it } from "vitest";

import { fitTitle } from "@/lib/visuals/fit";
import { buildPageRequests, RENDER_PAGE_PREFIX } from "@/lib/visuals/render";
import { createSlidesClient, type SlidesTransport } from "@/lib/visuals/slides-client";
import { buildSlotMap } from "@/lib/visuals/slots";
import { pngDimensions } from "@/lib/visuals/store";
import { elementText, placeholdersIn, TITLE_PLACEHOLDER, token } from "@/lib/visuals/template";
import type { GeneratedCopyRow } from "@/types";

const live = Boolean(
  process.env.SLIDES_LIVE_SMOKE === "1" &&
  process.env.GOOGLE_SA_EMAIL &&
  process.env.GOOGLE_SA_PRIVATE_KEY_B64 &&
  process.env.SLIDES_DECK_SINGLE_POST,
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the live smoke test`);
  return value;
}

/** Ids this test creates. Prefixed so the stage's own sweep is the backstop for a crashed run. */
const PAGE_ID = `${RENDER_PAGE_PREFIX}smokep`;
const TITLE_ID = `${RENDER_PAGE_PREFIX}smoket`;

/** Obviously-a-test copy, in Polish, so a leftover page is unmistakable if one ever survives. */
const FIXTURE: GeneratedCopyRow = {
  id: "live-smoke",
  digest_id: "live-smoke",
  cluster_id: "live-smoke",
  polish_title: "Test techniczny renderowania — nie publikować",
  caption_summary: "Test",
  body_copy: "Test",
  key_statistics: [
    { label: "Wzrost cen", value: "8,3%" },
    { label: "Cena za m²", value: "4 250 €" },
    { label: "Transakcje", value: "1 120" },
  ],
  source_text_origin: "article",
  source_char_count: 0,
  created_at: new Date().toISOString(),
};

let slides: SlidesTransport | null = null;
let deckId = "";

async function deletePage(): Promise<void> {
  if (!slides || !deckId) return;
  await slides.batchUpdate(deckId, [{ deleteObject: { objectId: PAGE_ID } }]);
}

describe.skipIf(!live)("Slides rendering (live smoke)", () => {
  afterAll(deletePage);

  it("duplicates, fills, exports and removes a page in the real single-post deck", async () => {
    deckId = requireEnv("SLIDES_DECK_SINGLE_POST");
    slides = createSlidesClient({
      serviceAccountEmail: requireEnv("GOOGLE_SA_EMAIL"),
      privateKeyBase64: requireEnv("GOOGLE_SA_PRIVATE_KEY_B64"),
    });
    expect(slides, "GOOGLE_SA_PRIVATE_KEY_B64 did not decode into a private key").not.toBeNull();
    if (!slides) return;

    // --- read the template the operator built -------------------------------------------------
    const presentation = await slides.getPresentation(deckId);
    expect(presentation.ok, presentation.ok ? "" : `${presentation.reason}: ${presentation.message}`).toBe(true);
    if (!presentation.ok) return;

    // Any leftover from an earlier interrupted run, so indexes below mean what they say.
    const templates = presentation.data.slides.filter((slide) => !slide.objectId.startsWith(RENDER_PAGE_PREFIX));
    const storySlide = templates.at(0);
    expect(storySlide, "the single-post deck has no slides").toBeDefined();
    if (!storySlide) return;

    const titleElement = (storySlide.pageElements ?? []).find((element) =>
      placeholdersIn(elementText(element)).includes(TITLE_PLACEHOLDER),
    );
    expect(
      titleElement,
      `the story slide has no ${token(TITLE_PLACEHOLDER)} box — run npm run visuals:validate`,
    ).toBeDefined();
    if (!titleElement) return;

    // --- build the same requests the stage builds ----------------------------------------------
    const slots = buildSlotMap(FIXTURE);
    expect(slots.ok, slots.ok ? "" : slots.message).toBe(true);
    const size = fitTitle(FIXTURE.polish_title);
    expect(size.ok, size.ok ? "" : size.message).toBe(true);
    if (!slots.ok || !size.ok) return;

    const requests = buildPageRequests(
      {
        slideIndex: 0,
        clusterId: FIXTURE.cluster_id,
        templatePageId: storySlide.objectId,
        templateTitleElementId: titleElement.objectId,
        titlePointSize: size.data,
        slots: slots.data,
      },
      PAGE_ID,
      TITLE_ID,
    );

    try {
      const applied = await slides.batchUpdate(deckId, requests);
      expect(applied.ok, applied.ok ? "" : `${applied.reason}: ${applied.message}`).toBe(true);
      if (!applied.ok) return;

      // --- export ------------------------------------------------------------------------------
      const exported = await slides.getPageThumbnail(deckId, PAGE_ID);
      expect(exported.ok, exported.ok ? "" : `${exported.reason}: ${exported.message}`).toBe(true);
      if (!exported.ok) return;

      // Real PNG bytes, not a URL and not an error page with a 200 on it.
      const dimensions = pngDimensions(exported.data);
      expect(dimensions, "the export was not a PNG").not.toBeNull();
      expect(exported.data.length).toBeGreaterThan(10_000);
      if (!dimensions) return;
      // Square, because a 16:9 deck would letterbox on every platform. The validator calls that
      // fatal; this catches a deck whose page setup was changed after it last passed.
      expect(dimensions.width).toBe(dimensions.height);

      // --- the text actually landed -------------------------------------------------------------
      // Re-read rather than trusting batchUpdate's silence: a mistyped placeholder makes
      // replaceAllText a successful no-op, which would publish a card with {{TITLE}} across it.
      const after = await slides.getPresentation(deckId);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const rendered = after.data.slides.find((slide) => slide.objectId === PAGE_ID);
      expect(rendered, "the duplicated page is not in the deck").toBeDefined();
      const renderedText = (rendered?.pageElements ?? []).map(elementText).join("\n");
      expect(renderedText).toContain(FIXTURE.polish_title);
      expect(renderedText).not.toContain(token(TITLE_PLACEHOLDER));
    } finally {
      const removed = await slides.batchUpdate(deckId, [{ deleteObject: { objectId: PAGE_ID } }]);
      expect(removed.ok, removed.ok ? "" : `cleanup failed: ${removed.message}`).toBe(true);
    }

    // --- the operator's template is exactly as they left it -------------------------------------
    const final = await slides.getPresentation(deckId);
    expect(final.ok).toBe(true);
    if (!final.ok) return;

    expect(final.data.slides.some((slide) => slide.objectId.startsWith(RENDER_PAGE_PREFIX))).toBe(false);
    const template = final.data.slides.find((slide) => slide.objectId === storySlide.objectId);
    expect(template, "the template slide is gone").toBeDefined();
    const templateText = (template?.pageElements ?? []).map(elementText).join("\n");
    expect(templateText).toContain(token(TITLE_PLACEHOLDER));
    expect(templateText).not.toContain(FIXTURE.polish_title);
  }, 90_000);
});
