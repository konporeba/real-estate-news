// Unit tests for the FR-019 approval-ready notification. No transport and no network: the builder
// is a pure function precisely so the mapping that matters — the key-statistic count, the
// lede-origin marker, and the CTA's dependence on an optional env var — can be asserted without
// sending anything. Mirrors src/lib/email/digest-ready.test.ts.
import { describe, expect, it } from "vitest";

import { buildApprovalReadyEmail, type ApprovalReadyItem, type ApprovalReadySummary } from "@/lib/email/approval-ready";

const DIGEST: ApprovalReadySummary = {
  id: "11111111-1111-4111-8111-111111111111",
  window_start: "2026-08-24",
  window_end: "2026-08-30",
};

function item(overrides: Partial<ApprovalReadyItem> = {}): ApprovalReadyItem {
  return {
    polishTitle: "Ceny najmu w Barcelonie wzrosły o 8%",
    captionSummary: "Wzrost jest najwyższy od 2023 roku.",
    keyStatisticsCount: 2,
    sourceTextOrigin: "article",
    ...overrides,
  };
}

describe("buildApprovalReadyEmail", () => {
  it("names the week in the subject", () => {
    const email = buildApprovalReadyEmail(DIGEST, [item()], "https://news.example");

    expect(email.subject).toContain("2026-08-24");
    expect(email.subject).toContain("2026-08-30");
  });

  it("states how many stories are waiting", () => {
    const email = buildApprovalReadyEmail(DIGEST, [item(), item(), item()], undefined);

    expect(email.content.bodyHtml).toContain("3 stories are");
  });

  it("uses singular wording for a one-story digest", () => {
    const email = buildApprovalReadyEmail(DIGEST, [item()], undefined);

    expect(email.content.bodyHtml).toContain("1 story is");
  });

  it("renders the Polish title and caption", () => {
    const email = buildApprovalReadyEmail(DIGEST, [item()], undefined);

    expect(email.content.bodyHtml).toContain("Ceny najmu w Barcelonie");
    expect(email.content.bodyHtml).toContain("Wzrost jest najwyższy");
  });

  it("escapes Polish text safely, unbroken by HTML entities", () => {
    const email = buildApprovalReadyEmail(
      DIGEST,
      [item({ polishTitle: "Rządowa ulga <podatkowa> dla najemców" })],
      undefined,
    );

    expect(email.content.bodyHtml).toContain("Rządowa ulga &lt;podatkowa&gt; dla najemców");
  });
});

describe("the key-statistics and source-origin marker", () => {
  it("counts the pulled-out statistics", () => {
    const html = buildApprovalReadyEmail(DIGEST, [item({ keyStatisticsCount: 3 })], undefined).content.bodyHtml;

    expect(html).toContain("3 statistics");
  });

  it("uses singular wording for exactly one statistic", () => {
    const html = buildApprovalReadyEmail(DIGEST, [item({ keyStatisticsCount: 1 })], undefined).content.bodyHtml;

    expect(html).toContain("1 statistic<");
  });

  it("handles zero statistics without rendering a negative or odd count", () => {
    const html = buildApprovalReadyEmail(DIGEST, [item({ keyStatisticsCount: 0 })], undefined).content.bodyHtml;

    expect(html).toContain("0 statistics");
  });

  it("marks a lede-fallback story so a short post is explained, not mysterious", () => {
    const withLede = buildApprovalReadyEmail(DIGEST, [item({ sourceTextOrigin: "lede" })], undefined).content.bodyHtml;
    const withArticle = buildApprovalReadyEmail(DIGEST, [item({ sourceTextOrigin: "article" })], undefined).content
      .bodyHtml;

    expect(withLede).toContain("short source");
    expect(withArticle).not.toContain("short source");
  });
});

describe("the call to action", () => {
  it("links to the approval page, not the digest page, when a base URL is configured", () => {
    const email = buildApprovalReadyEmail(DIGEST, [item()], "https://news.example");

    expect(email.content.cta?.url).toBe(`https://news.example/dashboard/${DIGEST.id}/approve`);
  });

  it("does not double the slash when the base URL has a trailing one", () => {
    const email = buildApprovalReadyEmail(DIGEST, [item()], "https://news.example/");

    expect(email.content.cta?.url).toBe(`https://news.example/dashboard/${DIGEST.id}/approve`);
  });

  it("omits the button entirely when no base URL is configured", () => {
    const email = buildApprovalReadyEmail(DIGEST, [item()], undefined);

    // Better no button than one pointing nowhere — the stories are still in the body.
    expect(email.content.cta).toBeUndefined();
    expect(email.content.bodyHtml).toContain("Ceny najmu w Barcelonie");
  });
});

describe("no image URLs", () => {
  it("never embeds a storage or signed-url reference in the body", () => {
    const html = buildApprovalReadyEmail(DIGEST, [item()], "https://news.example").content.bodyHtml;

    expect(html).not.toContain("digest-assets");
    expect(html).not.toContain("signedUrl");
    expect(html).not.toMatch(/<img/i);
  });
});

describe("an empty story list", () => {
  it("still builds a coherent message", () => {
    const build = () => buildApprovalReadyEmail(DIGEST, [], "https://news.example");

    expect(build).not.toThrow();
    expect(build().content.bodyHtml).toContain("0 stories are");
  });
});
