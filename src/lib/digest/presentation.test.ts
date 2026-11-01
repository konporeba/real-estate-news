import { describe, expect, it } from "vitest";

import { Constants } from "@/db/database.types";
import {
  currentStepIndex,
  formatWeek,
  NEEDS_OPERATOR_STATUSES,
  PIPELINE_STEPS,
  STATUS_PRESENTATION,
} from "@/lib/digest/presentation";

const ALL_STATUSES = Constants.public.Enums.digest_status;

describe("STATUS_PRESENTATION", () => {
  it("never shows the operator a raw enum name", () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_PRESENTATION[status].label).not.toContain("_");
    }
  });

  it("uses the 'your turn' tone for exactly the two human gates", () => {
    const turn = ALL_STATUSES.filter((status) => STATUS_PRESENTATION[status].tone === "turn");
    expect(turn).toEqual(["ready_for_selection", "ready_for_approval"]);
  });
});

describe("NEEDS_OPERATOR_STATUSES", () => {
  it("includes both gates, unlike the old pre-selection-only filter", () => {
    expect(NEEDS_OPERATOR_STATUSES).toContain("ready_for_selection");
    expect(NEEDS_OPERATOR_STATUSES).toContain("ready_for_approval");
  });

  it("leaves a closed week out: closing is how the operator stops it asking", () => {
    expect(NEEDS_OPERATOR_STATUSES).not.toContain("closed");
  });
});

describe("currentStepIndex", () => {
  it("places each gate on its operator step", () => {
    expect(PIPELINE_STEPS[currentStepIndex("ready_for_selection") ?? -1]?.operator).toBe(true);
    expect(PIPELINE_STEPS[currentStepIndex("ready_for_approval") ?? -1]?.operator).toBe(true);
  });

  it("only moves forward along the happy path", () => {
    const path = [
      "collecting",
      "ranking",
      "ready_for_selection",
      "generating",
      "rendering",
      "ready_for_approval",
      "approved",
      "published",
    ] as const;
    const indexes = path.map((status) => currentStepIndex(status) ?? -1);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(indexes.at(-1)).toBe(PIPELINE_STEPS.length);
  });

  it("draws no timeline for a failed or closed digest", () => {
    expect(currentStepIndex("failed")).toBeNull();
    expect(currentStepIndex("closed")).toBeNull();
  });
});

describe("formatWeek", () => {
  it("collapses a single-month week", () => {
    expect(formatWeek("2026-10-12", "2026-10-18")).toBe("12–18 October");
  });

  it("names both months across a boundary", () => {
    expect(formatWeek("2026-09-28", "2026-10-04")).toBe("28 September – 4 October");
  });

  it("falls back to the raw strings for a malformed date", () => {
    expect(formatWeek("nope", "2026-10-04")).toBe("nope – 2026-10-04");
  });
});
