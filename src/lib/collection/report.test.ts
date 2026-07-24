import { describe, expect, it } from "vitest";

import {
  COLLECTION_REPORT_VERSION,
  collectionReportSchema,
  parseCollectionReport,
  type CollectionReport,
} from "@/lib/collection/report";

function validReport(overrides: Partial<CollectionReport> = {}): CollectionReport {
  return {
    version: COLLECTION_REPORT_VERSION,
    window: { from: "2026-07-19T17:04:31.000Z", to: "2026-07-26T17:00:00.000Z" },
    sources: [
      {
        slug: "lavanguardia-economia",
        name: "La Vanguardia — Economía",
        role: "primary",
        tier: "rss",
        status: "ok",
        itemsFetched: 100,
        itemsInserted: 42,
        error: null,
        durationMs: 812,
      },
    ],
    poolSize: 42,
    thresholdMet: true,
    fallbacksRan: false,
    aiWebSearchSkipped: true,
    completedAt: "2026-07-26T17:00:12.000Z",
    ...overrides,
  };
}

describe("collectionReportSchema", () => {
  it("accepts a well-formed report", () => {
    expect(collectionReportSchema.safeParse(validReport()).success).toBe(true);
  });

  it("records a failed source with its error message", () => {
    const report = validReport({
      sources: [
        {
          slug: "idealista-news",
          name: "Idealista — News",
          role: "primary",
          tier: "rendered",
          status: "failed",
          itemsFetched: 0,
          itemsInserted: 0,
          error: 'TierNotImplementedError: collection tier "rendered" is not implemented yet',
          durationMs: 3,
        },
      ],
    });

    expect(collectionReportSchema.safeParse(report).success).toBe(true);
  });

  it("rejects an unknown source status", () => {
    const report = validReport();
    const broken = { ...report, sources: [{ ...report.sources[0], status: "maybe" }] };

    expect(collectionReportSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects negative counts", () => {
    const report = validReport();
    const broken = { ...report, sources: [{ ...report.sources[0], itemsInserted: -1 }] };

    expect(collectionReportSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a non-ISO window bound", () => {
    expect(collectionReportSchema.safeParse(validReport({ window: { from: "last week", to: "now" } })).success).toBe(
      false,
    );
  });

  // The flag exists to distinguish "we tried everything" from "one avenue was unavailable".
  it("requires the AI-web-search-skipped flag to be explicit", () => {
    const { aiWebSearchSkipped: _omitted, ...withoutFlag } = validReport();

    expect(collectionReportSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it("accepts an empty source list (a run that collected nothing still reports)", () => {
    const report = validReport({ sources: [], poolSize: 0, thresholdMet: false, fallbacksRan: true });

    expect(collectionReportSchema.safeParse(report).success).toBe(true);
  });
});

describe("parseCollectionReport", () => {
  it("round-trips a report through JSON, as the jsonb column will", () => {
    const parsed = parseCollectionReport(JSON.parse(JSON.stringify(validReport())));

    expect(parsed?.poolSize).toBe(42);
    expect(parsed?.sources[0].slug).toBe("lavanguardia-economia");
  });

  it("returns null for a null column rather than throwing", () => {
    expect(parseCollectionReport(null)).toBeNull();
  });

  it("returns null for a future report version instead of breaking the reader", () => {
    expect(parseCollectionReport(validReport({ version: 2 as 1 }))).toBeNull();
  });

  it("returns null for junk", () => {
    expect(parseCollectionReport({ nonsense: true })).toBeNull();
  });
});
