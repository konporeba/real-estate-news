import { describe, expect, it, vi } from "vitest";

import type { Presentation, SlidesTransport } from "@/lib/visuals/slides-client";
import { token } from "@/lib/visuals/template";
import { planPreview, PREVIEW_SAMPLES, PreviewRefused, renderPreview } from "@/worker/visuals-preview";

const textBox = (text: string, objectId: string) => ({
  objectId,
  shape: { text: { textElements: [{ textRun: { content: text } }] } },
});

const tagged = (objectId: string, notes: string, elements: ReturnType<typeof textBox>[] = []) => ({
  objectId,
  pageElements: elements,
  slideProperties: {
    notesPage: {
      notesProperties: { speakerNotesObjectId: `${objectId}-n` },
      pageElements: [textBox(notes, `${objectId}-n`)],
    },
  },
});

const story = (objectId: string, section: string) =>
  tagged(objectId, `role=story section=${section}`, [
    textBox(`${token("TITLE")}\n${token("DESCRIPTION")}`, `${objectId}-box`),
  ]);

const slides = () => [
  tagged("cover", "role=cover"),
  story("b1", "barcelona"),
  story("s1", "spain"),
  story("f1", "finance_law"),
  story("b2", "barcelona"),
];

/** A PNG header the dimension check accepts. */
function png(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1280, false);
  view.setUint32(20, 1600, false);
  return bytes;
}

function fakeSlides(presentation: Presentation, failOn?: string) {
  const deleted: string[] = [];
  const transport: SlidesTransport = {
    getPresentation: () => Promise.resolve({ ok: true, data: presentation }),
    batchUpdate: (_id, requests) => {
      for (const request of requests) {
        const del = request.deleteObject as { objectId: string } | undefined;
        if (del) deleted.push(del.objectId);
      }
      return Promise.resolve({ ok: true, data: undefined });
    },
    getPageThumbnail: vi.fn((_id: string, pageId: string) =>
      Promise.resolve(
        pageId === failOn
          ? ({ ok: false, reason: "api_error", message: "500" } as const)
          : ({ ok: true, data: png() } as const),
      ),
    ),
  };
  return { transport, deleted };
}

describe("planPreview", () => {
  it("plans the cover, then every photo slide in deck order with the samples cycled", () => {
    const { plans, names } = planPreview(slides());

    expect(names).toEqual([
      "00-cover",
      "01-barcelona-short",
      "02-spain-typical",
      "03-finance_law-long",
      "04-barcelona-short",
    ]);
    expect(plans[0]).toMatchObject({ kind: "cover", templatePageId: "cover" });
    expect(plans.slice(1).map((plan) => plan.templatePageId)).toEqual(["b1", "s1", "f1", "b2"]);
  });

  // The long sample is the point of the preview: it must still fit, or the preview proves nothing.
  it("fits every sample, including the long one", () => {
    expect(PREVIEW_SAMPLES.map((sample) => sample.name)).toContain("long");
    expect(() => planPreview(slides())).not.toThrow();
  });

  it("refuses a deck that fails the template spec, pointing at the validator", () => {
    expect(() => planPreview(slides().slice(1))).toThrow(PreviewRefused);
    expect(() => planPreview(slides().slice(1))).toThrow("visuals:validate");
  });
});

describe("renderPreview", () => {
  it("writes one PNG per page and deletes every duplicate", async () => {
    const fake = fakeSlides({ presentationId: "deck", slides: slides() });
    const written: string[] = [];

    const outcome = await renderPreview(fake.transport, "deck", "out", (path) => written.push(path));

    expect(outcome.failures).toEqual([]);
    expect(written).toEqual([
      "out/00-cover.png",
      "out/01-barcelona-short.png",
      "out/02-spain-typical.png",
      "out/03-finance_law-long.png",
      "out/04-barcelona-short.png",
    ]);
    expect(fake.deleted.filter((id) => id.startsWith("renderx"))).toHaveLength(4);
    expect(fake.deleted).not.toContain("cover");
  });

  it("keeps going past a page that fails, and reports it", async () => {
    const fake = fakeSlides({ presentationId: "deck", slides: slides() }, "renderx2p");
    const written: string[] = [];

    const outcome = await renderPreview(fake.transport, "deck", "out", (path) => written.push(path));

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatch(/^02-spain-typical:/);
    expect(written).toHaveLength(4);
  });
});
