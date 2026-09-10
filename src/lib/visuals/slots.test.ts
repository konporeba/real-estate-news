import { describe, expect, it } from "vitest";

import {
  buildCoverSlots,
  buildSlotMap,
  COVER_PLACEHOLDERS,
  formatWindow,
  parseKeyStatistics,
  STAT_SLOT_COUNT,
  STORY_PLACEHOLDERS,
} from "@/lib/visuals/slots";
import type { GeneratedCopyRow } from "@/types";

/** `key_statistics` as it actually arrives: jsonb, so a plain literal rather than `KeyStatistic[]`. */
const stats = (count: number): { label: string; value: string }[] =>
  Array.from({ length: count }, (_, index) => ({
    label: `Etykieta ${String(index + 1)}`,
    value: `${String(index + 1)}%`,
  }));

function copyRow(overrides: Partial<GeneratedCopyRow> = {}): GeneratedCopyRow {
  return {
    id: "copy-1",
    digest_id: "digest-1",
    cluster_id: "cluster-1",
    polish_title: "Ceny mieszkań w Barcelonie rosną",
    caption_summary: "Podsumowanie",
    body_copy: "Treść",
    key_statistics: stats(3),
    source_text_origin: "article",
    source_char_count: 4200,
    created_at: "2026-09-08T10:00:00Z",
    ...overrides,
  };
}

describe("buildSlotMap — statistic counts", () => {
  it(`fills every story placeholder from exactly ${String(STAT_SLOT_COUNT)} statistics`, () => {
    const result = buildSlotMap(copyRow({ key_statistics: stats(3) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The map must cover the deck's whole story vocabulary — no more, no less. A missing key would
    // publish a literal `{{STAT_3_VALUE}}`; an extra one would be a placeholder the deck lacks.
    expect(Object.keys(result.data).sort()).toEqual([...STORY_PLACEHOLDERS].sort());
    expect(result.data.TITLE).toBe("Ceny mieszkań w Barcelonie rosną");
    expect(result.data.STAT_1_LABEL).toBe("Etykieta 1");
    expect(result.data.STAT_3_VALUE).toBe("3%");
  });

  it("takes the first three of four, dropping the rest", () => {
    const result = buildSlotMap(copyRow({ key_statistics: stats(4) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data).sort()).toEqual([...STORY_PLACEHOLDERS].sort());
    expect(result.data.STAT_3_LABEL).toBe("Etykieta 3");
  });

  it("takes the first three of five, dropping the rest", () => {
    const result = buildSlotMap(copyRow({ key_statistics: stats(5) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data).sort()).toEqual([...STORY_PLACEHOLDERS].sort());
    expect(result.data.STAT_3_VALUE).toBe("3%");
  });

  it("fails on two statistics rather than leaving a slot empty", () => {
    const result = buildSlotMap(copyRow({ key_statistics: stats(2) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("insufficient_statistics");
    expect(result.message).toContain("2 usable");
  });

  it("fails on none", () => {
    const result = buildSlotMap(copyRow({ key_statistics: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_statistics");
  });

  it("does not count a blank label or value towards the three", () => {
    const result = buildSlotMap(
      copyRow({
        key_statistics: [
          { label: "Wzrost", value: "8,3%" },
          { label: "   ", value: "12%" },
          { label: "Podaż", value: "  " },
          { label: "Czynsz", value: "1 200 €" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_statistics");
  });

  it("compacts around a blank entry when enough usable ones remain", () => {
    const result = buildSlotMap(
      copyRow({
        key_statistics: [
          { label: "Wzrost", value: "8,3%" },
          { label: "", value: "12%" },
          { label: "Podaż", value: "4 100" },
          { label: "Czynsz", value: "1 200 €" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.STAT_2_LABEL).toBe("Podaż");
    expect(result.data.STAT_3_LABEL).toBe("Czynsz");
  });

  it("trims the values it does use", () => {
    const result = buildSlotMap(copyRow({ key_statistics: [{ label: "  Wzrost  ", value: " 8,3% " }, ...stats(2)] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.STAT_1_LABEL).toBe("Wzrost");
  });
});

describe("buildSlotMap — bad rows", () => {
  it("rejects a blank title", () => {
    const result = buildSlotMap(copyRow({ polish_title: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_title");
  });

  it("trims the title it keeps", () => {
    const result = buildSlotMap(copyRow({ polish_title: "  Ceny rosną  " }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.TITLE).toBe("Ceny rosną");
  });

  it("reports a non-array key_statistics as malformed, not as too few", () => {
    const result = buildSlotMap(copyRow({ key_statistics: { label: "Wzrost", value: "8,3%" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_statistics");
  });

  it("reports a non-object entry as malformed", () => {
    const result = buildSlotMap(copyRow({ key_statistics: ["8,3%", "12%", "4 100"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_statistics");
  });

  it("reports a non-string value as malformed rather than coercing it", () => {
    const result = buildSlotMap(copyRow({ key_statistics: [{ label: "Wzrost", value: 8.3 }, ...stats(2)] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_statistics");
  });
});

describe("parseKeyStatistics", () => {
  it("round-trips a well-formed array", () => {
    const result = parseKeyStatistics(stats(2));
    expect(result).toEqual({
      ok: true,
      data: [
        { label: "Etykieta 1", value: "1%" },
        { label: "Etykieta 2", value: "2%" },
      ],
    });
  });

  it("rejects null, which is what an unset jsonb column reads back as", () => {
    const result = parseKeyStatistics(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_statistics");
  });
});

describe("formatWindow", () => {
  it("collapses a same-month week to one month and year", () => {
    expect(formatWindow("2026-09-01", "2026-09-07")).toBe("1–7 września 2026");
  });

  it("spells out both sides when the week crosses a month", () => {
    expect(formatWindow("2026-08-31", "2026-09-06")).toBe("31 sierpnia 2026 – 6 września 2026");
  });

  it("spells out both sides when the week crosses a year", () => {
    expect(formatWindow("2026-12-28", "2027-01-03")).toBe("28 grudnia 2026 – 3 stycznia 2027");
  });

  it("does not drift a day, whatever the host zone", () => {
    // The columns are dates, not instants; parsed naively in a westward zone the start would
    // print as the previous day. Pinning to UTC is what keeps this stable on the Pi and in CI.
    expect(formatWindow("2026-09-01", "2026-09-01")).toBe("1–1 września 2026");
  });

  it("falls back to the raw strings rather than throwing on an unparseable date", () => {
    expect(formatWindow("not-a-date", "2026-09-07")).toBe("not-a-date – 2026-09-07");
  });
});

describe("buildCoverSlots", () => {
  it("fills every cover placeholder", () => {
    const slots = buildCoverSlots({ window_start: "2026-09-01", window_end: "2026-09-07" });
    expect(Object.keys(slots).sort()).toEqual([...COVER_PLACEHOLDERS].sort());
    expect(slots.COVER_SUBTITLE).toBe("1–7 września 2026");
    expect(slots.COVER_TITLE).toBeTruthy();
  });
});
