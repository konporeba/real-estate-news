import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeItem, parseFeed, toPlainText } from "@/lib/collection/adapters/rss";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
}

describe("toPlainText", () => {
  it("strips markup and collapses whitespace", () => {
    expect(toPlainText("<p>El precio del <strong>alquiler</strong>  sube</p>")).toBe("El precio del alquiler sube");
  });

  it("decodes the entities feeds actually use", () => {
    expect(toPlainText("Pisos &amp; casas &quot;de lujo&quot;&nbsp;en Barcelona")).toBe(
      'Pisos & casas "de lujo" en Barcelona',
    );
  });
});

describe("normalizeItem", () => {
  it("rejects an item with no link", () => {
    expect(normalizeItem({ title: "Sin enlace" })).toBeNull();
  });

  it("rejects an item with no title", () => {
    expect(normalizeItem({ link: "https://example.test/a" })).toBeNull();
  });

  it("falls back to guid when link is absent", () => {
    const candidate = normalizeItem({ guid: "https://example.test/b", title: "Con guid" });
    expect(candidate?.sourceUrl).toBe("https://example.test/b");
  });

  it("returns a null lede rather than an empty string", () => {
    const candidate = normalizeItem({ link: "https://example.test/c", title: "Sin resumen" });
    expect(candidate?.lede).toBeNull();
  });

  it("rejects a structurally invalid item instead of throwing", () => {
    expect(normalizeItem({ link: 42, title: [] })).toBeNull();
    expect(normalizeItem(null)).toBeNull();
  });
});

describe("parseFeed — RSS 2.0", () => {
  it("normalizes items, stripping markup from the lede", async () => {
    const candidates = await parseFeed(fixture("rss2.xml"));
    const first = candidates[0];

    expect(first.title).toBe("El precio del alquiler en Barcelona sube un 8,2% interanual");
    expect(first.sourceUrl).toBe("https://www.expansion.com/inmobiliario/2026/07/20/alquiler-barcelona.html");
    expect(first.lede).toBe("El precio medio del alquiler en Barcelona alcanza los 1.180 euros mensuales.");
    expect(first.publishedAt?.toISOString()).toBe("2026-07-20T06:15:00.000Z");
  });

  it("keeps undated items with publishedAt null rather than dropping them", async () => {
    const candidates = await parseFeed(fixture("rss2.xml"));
    const undated = candidates.find((c) => c.title === "Artículo sin fecha de publicación");

    expect(undated).toBeDefined();
    expect(undated?.publishedAt).toBeNull();
  });

  it("treats an unparseable date as absent", async () => {
    const candidates = await parseFeed(fixture("rss2.xml"));
    const malformed = candidates.find((c) => c.title === "Fecha malformada");

    expect(malformed).toBeDefined();
    expect(malformed?.publishedAt).toBeNull();
  });

  it("drops items that cannot be an article", async () => {
    const candidates = await parseFeed(fixture("rss2.xml"));

    // Five <item> elements; the one with neither title nor link is not an article.
    expect(candidates).toHaveLength(4);
  });
});

describe("parseFeed — Atom", () => {
  it("normalizes entries from the Atom dialect", async () => {
    const candidates = await parseFeed(fixture("atom.xml"));

    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.title).toBe("Catalunya lidera la construcción de obra nueva");
    expect(candidates[0]?.sourceUrl).toBe("https://www.lavanguardia.com/economia/20260722/obra-nueva.html");
    expect(candidates[0]?.lede).toBe("Los visados de obra nueva crecen un 12% en Catalunya.");
    expect(candidates[0]?.publishedAt?.toISOString()).toBe("2026-07-22T09:00:00.000Z");
  });
});
