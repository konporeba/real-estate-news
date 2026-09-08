import { describe, expect, it, vi } from "vitest";

import type { Presentation, SlidesResult, SlidesTransport } from "@/lib/visuals/slides-client";
import { STORY_PLACEHOLDERS, TARGET_PAGE_EMU, token } from "@/lib/visuals/template";
import { type DeckTarget, formatReport, validateDecks } from "@/worker/validate-decks";

const conformingSinglePost: Presentation = {
  presentationId: "deck-single",
  pageSize: {
    width: { magnitude: TARGET_PAGE_EMU, unit: "EMU" },
    height: { magnitude: TARGET_PAGE_EMU, unit: "EMU" },
  },
  slides: [
    {
      objectId: "p1",
      pageElements: STORY_PLACEHOLDERS.map((name) => ({
        objectId: `el-${name}`,
        shape: { text: { textElements: [{ textRun: { content: token(name) } }] } },
      })),
    },
  ],
};

/** A transport that answers getPresentation from a lookup table; nothing else is exercised here. */
function fakeSlides(responses: Record<string, SlidesResult<Presentation>>): SlidesTransport {
  return {
    getPresentation: vi.fn((id: string) =>
      Promise.resolve(responses[id] ?? ({ ok: false, reason: "not_found", message: "no such deck" } as const)),
    ),
    batchUpdate: vi.fn(),
    getPageThumbnail: vi.fn(),
  };
}

const singlePostTarget: DeckTarget = { kind: "single_post", presentationId: "deck-single" };

describe("validateDecks", () => {
  it("reports no problems for a conforming deck", async () => {
    const slides = fakeSlides({ "deck-single": { ok: true, data: conformingSinglePost } });

    const reports = await validateDecks(slides, [singlePostTarget]);

    expect(reports).toHaveLength(1);
    expect(reports[0].problems).toEqual([]);
  });

  // Forgetting to share the deck is the single most likely setup mistake, and "403" on its own
  // sends the operator to the wrong place entirely.
  it("turns permission_denied into an actionable message about sharing", async () => {
    const slides = fakeSlides({
      "deck-single": { ok: false, reason: "permission_denied", message: "caller lacks permission" },
    });

    const reports = await validateDecks(slides, [singlePostTarget]);

    expect(reports[0].problems[0].fatal).toBe(true);
    expect(reports[0].problems[0].message).toMatch(/share the deck with the service account as Editor/);
  });

  it("points at the presentation id when the deck is not found", async () => {
    const slides = fakeSlides({ "deck-single": { ok: false, reason: "not_found", message: "nope" } });

    const reports = await validateDecks(slides, [singlePostTarget]);

    expect(reports[0].problems[0].message).toMatch(/check the presentation id in the Slides URL/);
  });

  // One unreadable deck must not hide what is wrong with the other, or the operator fixes one
  // problem per run.
  it("still checks the other deck when one cannot be read", async () => {
    const slides = fakeSlides({
      "deck-single": { ok: true, data: conformingSinglePost },
      "deck-carousel": { ok: false, reason: "permission_denied", message: "denied" },
    });

    const reports = await validateDecks(slides, [
      singlePostTarget,
      { kind: "carousel", presentationId: "deck-carousel" },
    ]);

    expect(reports).toHaveLength(2);
    expect(reports[0].problems).toEqual([]);
    expect(reports[1].problems[0].fatal).toBe(true);
  });

  it("reports the deck's own defects when it can be read", async () => {
    const stripped: Presentation = {
      ...conformingSinglePost,
      slides: [
        {
          objectId: "p1",
          pageElements: conformingSinglePost.slides[0].pageElements?.filter((el) => el.objectId !== "el-TITLE"),
        },
      ],
    };
    const slides = fakeSlides({ "deck-single": { ok: true, data: stripped } });

    const reports = await validateDecks(slides, [singlePostTarget]);

    expect(reports[0].problems.some((p) => p.message.includes("missing {{TITLE}}"))).toBe(true);
  });
});

describe("formatReport", () => {
  it("marks a clean deck OK", () => {
    expect(formatReport({ kind: "single_post", presentationId: "deck-single", problems: [] })).toContain("OK");
  });

  it("marks a deck with a fatal problem FAIL and lists it", () => {
    const output = formatReport({
      kind: "single_post",
      presentationId: "deck-single",
      problems: [{ fatal: true, message: "missing {{TITLE}}" }],
    });

    expect(output).toContain("FAIL");
    expect(output).toContain("error");
    expect(output).toContain("missing {{TITLE}}");
  });

  // A warning must be visibly different from an error, or the operator cannot tell what blocks
  // the pipeline from what is merely worth knowing.
  it("marks a deck with only warnings WARN", () => {
    const output = formatReport({
      kind: "carousel",
      presentationId: "deck-carousel",
      problems: [{ fatal: false, message: "page is square but not 1080 px" }],
    });

    expect(output).toContain("WARN");
    expect(output).not.toContain("FAIL");
  });
});
