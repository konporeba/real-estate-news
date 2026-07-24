import { describe, expect, it } from "vitest";

import { adapterFor, TierNotImplementedError } from "@/lib/collection/adapters";
import {
  MAX_ITEMS_PER_SOURCE,
  MIN_POOL_SIZE,
  SOURCE_LANGUAGES,
  SOURCE_ROLES,
  SOURCE_TIERS,
  SOURCES,
  sourcesForRole,
  type SourceDefinition,
} from "@/lib/collection/sources";

describe("source registry", () => {
  it("validates at import (a malformed entry would have thrown)", () => {
    expect(SOURCES.length).toBeGreaterThan(0);
  });

  it("has unique slugs", () => {
    const slugs = SOURCES.map((source) => source.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses only known tiers, roles and languages", () => {
    for (const source of SOURCES) {
      expect(SOURCE_TIERS).toContain(source.tier);
      expect(SOURCE_ROLES).toContain(source.role);
      expect(SOURCE_LANGUAGES).toContain(source.language);
    }
  });

  it("gives every disabled source a note explaining why", () => {
    for (const source of SOURCES.filter((s) => !s.enabled)) {
      expect(source.note, `${source.slug} is disabled without a note`).toBeTruthy();
    }
  });

  it("only enables sources on an implemented tier", () => {
    for (const source of SOURCES.filter((s) => s.enabled)) {
      expect(source.tier, `${source.slug} is enabled on an unimplemented tier`).toBe("rss");
    }
  });

  it("ships at least one enabled primary and one enabled fallback", () => {
    expect(sourcesForRole("primary").length).toBeGreaterThan(0);
    expect(sourcesForRole("fallback").length).toBeGreaterThan(0);
  });

  it("excludes disabled sources from role lookups", () => {
    const disabled = SOURCES.filter((s) => !s.enabled).map((s) => s.slug);
    const selected = [...sourcesForRole("primary"), ...sourcesForRole("fallback")].map((s) => s.slug);

    for (const slug of disabled) {
      expect(selected).not.toContain(slug);
    }
  });

  it("collects Catalan alongside Spanish, so downstream translation must handle both", () => {
    // Operator decision 2026-07-24 (roadmap OQ#1) widened FR-013 from es->pl to {es,ca}->pl.
    // If this fails because ca was disabled, S-02/S-03 translation scope changes with it.
    const languages = new Set(sourcesForRole("primary").map((s) => s.language));

    expect(languages).toContain("es");
    expect(languages).toContain("ca");
  });

  it("keeps the pool threshold above the shortlist size clustering must produce", () => {
    // FR-008 keeps the top 15 clusters; a pool at or below that leaves nothing to rank.
    expect(MIN_POOL_SIZE).toBeGreaterThan(15);
    expect(MAX_ITEMS_PER_SOURCE).toBeGreaterThan(0);
  });
});

describe("adapterFor", () => {
  const source = (tier: SourceDefinition["tier"]): SourceDefinition => ({
    slug: "test-source",
    name: "Test",
    tier,
    role: "primary",
    language: "es",
    url: "https://example.test/feed",
    enabled: true,
  });

  it("resolves an adapter for every tier", () => {
    for (const tier of SOURCE_TIERS) {
      expect(typeof adapterFor(source(tier))).toBe("function");
    }
  });

  it.each(["api", "rendered"] as const)("rejects with TierNotImplementedError for the %s tier", async (tier) => {
    const adapter = adapterFor(source(tier));

    await expect(adapter(source(tier), { from: new Date(), to: new Date() })).rejects.toThrow(TierNotImplementedError);
  });

  it("names the tier and source in the error", async () => {
    const adapter = adapterFor(source("rendered"));

    await expect(adapter(source("rendered"), { from: new Date(), to: new Date() })).rejects.toThrow(
      /rendered.*test-source/,
    );
  });
});
