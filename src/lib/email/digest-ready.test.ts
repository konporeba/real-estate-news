// Unit tests for the FR-010 digest-ready notification. No transport and no network: the builder
// is a pure function precisely so the mapping that matters — rubric tier onto the card
// primitive's generic scale, and the CTA's dependence on an optional env var — can be asserted
// without sending anything.
import { describe, expect, it } from "vitest";

import { buildDigestReadyEmail, type DigestReadyItem, type DigestReadySummary } from "@/lib/email/digest-ready";

const DIGEST: DigestReadySummary = {
  id: "11111111-1111-4111-8111-111111111111",
  window_start: "2026-08-24",
  window_end: "2026-08-30",
};

function item(overrides: Partial<DigestReadyItem> = {}): DigestReadyItem {
  return {
    rank: 1,
    tier: "catalonia",
    coverageCount: 3,
    polishTitle: "Ceny najmu w Barcelonie wzrosły o 8%",
    polishSummary: "Wzrost jest najwyższy od 2023 roku.",
    originalTitle: "El preu del lloguer a Barcelona puja un 8%",
    originalLede: "L'increment és el més alt des del 2023.",
    sourceUrl: "https://example.test/story",
    ...overrides,
  };
}

describe("buildDigestReadyEmail", () => {
  it("names the week in the subject", () => {
    const email = buildDigestReadyEmail(DIGEST, [item()], "https://news.example");

    expect(email.subject).toContain("2026-08-24");
    expect(email.subject).toContain("2026-08-30");
  });

  it("states how many stories are waiting", () => {
    const email = buildDigestReadyEmail(DIGEST, [item(), item({ rank: 2 }), item({ rank: 3 })], undefined);

    expect(email.content.bodyHtml).toContain("3 stories are");
    expect(email.content.bodyHtml).toContain("Pick 2–4");
  });

  it("uses singular wording for a one-story shortlist", () => {
    const email = buildDigestReadyEmail(DIGEST, [item()], undefined);

    expect(email.content.bodyHtml).toContain("1 story is");
  });

  it("renders the Polish title and summary when the story is translated", () => {
    const email = buildDigestReadyEmail(DIGEST, [item()], undefined);

    expect(email.content.bodyHtml).toContain("Ceny najmu w Barcelonie");
    expect(email.content.bodyHtml).toContain("Wzrost jest najwyższy");
  });

  it("falls back to the original title and lede rather than rendering empty", () => {
    const email = buildDigestReadyEmail(DIGEST, [item({ polishTitle: null, polishSummary: null })], undefined);

    expect(email.content.bodyHtml).toContain("El preu del lloguer");
    expect(email.content.bodyHtml).toContain("L&#39;increment és el més alt");
  });

  it("annotates each story with its coverage count", () => {
    const html = buildDigestReadyEmail(DIGEST, [item({ coverageCount: 3 }), item({ coverageCount: 1 })], undefined)
      .content.bodyHtml;

    expect(html).toContain("3 sources");
    expect(html).toContain("1 source<");
  });
});

describe("tier mapping", () => {
  // The rubric's four tiers onto the layout's generic high/medium/low scale. The colour is the
  // operator's at-a-glance signal in the inbox, so a wrong mapping here is a wrong editorial cue.
  it.each([
    ["catalonia", "Catalonia"],
    ["national", "National"],
    ["global", "Global"],
    ["discard", "Low"],
  ])("labels the %s tier as %s", (tier, label) => {
    const email = buildDigestReadyEmail(DIGEST, [item({ tier })], undefined);

    expect(email.content.bodyHtml).toContain(label);
  });

  it("degrades an unrecognised tier instead of throwing", () => {
    const build = () => buildDigestReadyEmail(DIGEST, [item({ tier: "something-new" })], undefined);

    expect(build).not.toThrow();
    expect(build().content.bodyHtml).toContain("something-new");
  });

  it("renders no score pill for an unscored story", () => {
    const withTier = buildDigestReadyEmail(DIGEST, [item({ tier: "catalonia" })], undefined).content.bodyHtml;
    const withoutTier = buildDigestReadyEmail(DIGEST, [item({ tier: null })], undefined).content.bodyHtml;

    // Claiming "low" for a story that was never scored would be a claim the data cannot support.
    expect(withTier).toContain("Catalonia");
    expect(withoutTier).not.toContain("Catalonia");
    expect(withoutTier.length).toBeLessThan(withTier.length);
  });
});

describe("the call to action", () => {
  it("links to the digest when a base URL is configured", () => {
    const email = buildDigestReadyEmail(DIGEST, [item()], "https://news.example");

    expect(email.content.cta?.url).toBe(`https://news.example/dashboard/${DIGEST.id}`);
  });

  it("does not double the slash when the base URL has a trailing one", () => {
    const email = buildDigestReadyEmail(DIGEST, [item()], "https://news.example/");

    expect(email.content.cta?.url).toBe(`https://news.example/dashboard/${DIGEST.id}`);
  });

  it("omits the button entirely when no base URL is configured", () => {
    const email = buildDigestReadyEmail(DIGEST, [item()], undefined);

    // Better no button than one pointing nowhere — the shortlist is still in the body.
    expect(email.content.cta).toBeUndefined();
    expect(email.content.bodyHtml).toContain("Ceny najmu w Barcelonie");
  });
});

describe("an empty shortlist", () => {
  it("still builds a coherent message", () => {
    const build = () => buildDigestReadyEmail(DIGEST, [], "https://news.example");

    expect(build).not.toThrow();
    expect(build().content.bodyHtml).toContain("0 stories are");
  });
});
