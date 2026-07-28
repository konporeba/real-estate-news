import { describe, expect, it } from "vitest";

import { renderArticleCards, renderEmailHtml, renderEmailText } from "@/lib/email/layout";

describe("renderEmailHtml", () => {
  it("includes the heading and body", () => {
    const html = renderEmailHtml({ heading: "Digest ready", bodyHtml: "<p>Fifteen stories are waiting.</p>" });
    expect(html).toContain("Digest ready");
    expect(html).toContain("<p>Fifteen stories are waiting.</p>");
  });

  it("escapes the heading so it cannot break the surrounding markup", () => {
    const html = renderEmailHtml({ heading: "<script>alert(1)</script>", bodyHtml: "<p>body</p>" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the CTA block when no cta is given", () => {
    const html = renderEmailHtml({ heading: "Digest ready", bodyHtml: "<p>body</p>" });
    expect(html).not.toContain("href=");
  });

  it("renders the CTA button only when cta is given", () => {
    const html = renderEmailHtml({
      heading: "Digest ready",
      bodyHtml: "<p>body</p>",
      cta: { text: "Review shortlist", url: "https://example.com/dashboard" },
    });
    expect(html).toContain("Review shortlist");
    expect(html).toContain("https://example.com/dashboard");
  });

  it("contains no <style> block — every rule must be inline for Gmail compatibility", () => {
    const html = renderEmailHtml({ heading: "Digest ready", bodyHtml: "<p>body</p>" });
    expect(html).not.toContain("<style");
  });
});

describe("renderEmailText", () => {
  it("returns bodyText verbatim when supplied", () => {
    const text = renderEmailText({ heading: "Digest ready", bodyHtml: "<p>ignored</p>", bodyText: "Plain override" });
    expect(text).toBe("Plain override");
  });

  it("derives a tag-stripped fallback from heading + bodyHtml when bodyText is omitted", () => {
    const text = renderEmailText({ heading: "Digest ready", bodyHtml: "<p>Fifteen <b>stories</b> are waiting.</p>" });
    expect(text).toContain("Digest ready");
    expect(text).toContain("Fifteen stories are waiting.");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("<b>");
  });

  it("appends the CTA as a text line when present and bodyText is derived", () => {
    const text = renderEmailText({
      heading: "Digest ready",
      bodyHtml: "<p>body</p>",
      cta: { text: "Review shortlist", url: "https://example.com/dashboard" },
    });
    expect(text).toContain("Review shortlist: https://example.com/dashboard");
  });
});

describe("renderArticleCards", () => {
  it("returns an empty string for an empty list", () => {
    expect(renderArticleCards([])).toBe("");
  });

  it("renders each article's title", () => {
    const html = renderArticleCards([
      { title: "Barcelona rental prices rise 8%" },
      { title: "Bank of Spain cuts rates" },
    ]);
    expect(html).toContain("Barcelona rental prices rise 8%");
    expect(html).toContain("Bank of Spain cuts rates");
  });

  it("links the title when a url is given, and renders plain text when it isn't", () => {
    const withUrl = renderArticleCards([{ title: "Linked story", url: "https://example.com/a" }]);
    expect(withUrl).toContain('href="https://example.com/a"');
    expect(withUrl).toContain("Linked story");

    const withoutUrl = renderArticleCards([{ title: "Unlinked story" }]);
    expect(withoutUrl).not.toContain("href=");
    expect(withoutUrl).toContain("Unlinked story");
  });

  it("renders the meta line only when given", () => {
    const withMeta = renderArticleCards([{ title: "Story", meta: "3 sources · Barcelona/Catalonia" }]);
    expect(withMeta).toContain("3 sources");

    const withoutMeta = renderArticleCards([{ title: "Story" }]);
    expect(withoutMeta).not.toContain("sources");
  });

  it("renders the description only when given", () => {
    const withDescription = renderArticleCards([{ title: "Story", description: "A short summary of the story." }]);
    expect(withDescription).toContain("A short summary of the story.");

    const withoutDescription = renderArticleCards([{ title: "Story" }]);
    expect(withoutDescription).not.toContain("A short summary of the story.");
  });

  it("renders a 'Read article' link only when a url is given", () => {
    const withUrl = renderArticleCards([{ title: "Story", url: "https://example.com/a" }]);
    expect(withUrl).toContain("Read article");

    const withoutUrl = renderArticleCards([{ title: "Story" }]);
    expect(withoutUrl).not.toContain("Read article");
  });

  it("numbers each card by its position, starting at 1", () => {
    const html = renderArticleCards([{ title: "First" }, { title: "Second" }, { title: "Third" }]);
    const numbers = [...html.matchAll(/font-weight: 700; font-family: [^>]*>(\d+)<\/span>/g)].map((m) => m[1]);
    expect(numbers).toEqual(["1", "2", "3"]);
  });

  it("escapes title, url, description, and meta so they cannot break the surrounding markup", () => {
    const html = renderArticleCards([
      {
        title: "<b>injected</b>",
        url: 'https://example.com/"quoted',
        description: "<u>desc</u>",
        meta: "<i>meta</i>",
      },
    ]);
    expect(html).not.toContain("<b>injected</b>");
    expect(html).toContain("&lt;b&gt;injected&lt;/b&gt;");
    expect(html).toContain("&quot;quoted");
    expect(html).not.toContain("<u>desc</u>");
    expect(html).not.toContain("<i>meta</i>");
  });

  it("renders the score label only when a score is given", () => {
    const withScore = renderArticleCards([{ title: "Story", score: { tier: "high", label: "Barcelona/Catalonia" } }]);
    expect(withScore).toContain("Barcelona/Catalonia");

    const withoutScore = renderArticleCards([{ title: "Story" }]);
    expect(withoutScore).not.toContain("Barcelona/Catalonia");
  });

  it("uses a distinct accent color per score tier, as a tier-colored left border", () => {
    const high = renderArticleCards([{ title: "Story", score: { tier: "high", label: "High" } }]);
    const medium = renderArticleCards([{ title: "Story", score: { tier: "medium", label: "Medium" } }]);
    const low = renderArticleCards([{ title: "Story", score: { tier: "low", label: "Low" } }]);

    expect(high).toContain("border-left: 4px solid #16a34a");
    expect(medium).toContain("border-left: 4px solid #d97706");
    expect(low).toContain("border-left: 4px solid #64748b");
  });

  it("omits the tier-colored left border when no score is given", () => {
    const withoutScore = renderArticleCards([{ title: "Story" }]);
    expect(withoutScore).not.toContain("border-left");
  });

  it("escapes the score label", () => {
    const html = renderArticleCards([{ title: "Story", score: { tier: "high", label: "<b>injected</b>" } }]);
    expect(html).not.toContain("<b>injected</b>");
    expect(html).toContain("&lt;b&gt;injected&lt;/b&gt;");
  });
});
