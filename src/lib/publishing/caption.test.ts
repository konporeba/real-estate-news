import { describe, expect, it } from "vitest";

import { composeCaption, truncateForPlatform } from "@/lib/publishing/caption";

describe("composeCaption", () => {
  it("returns a single summary unchanged", () => {
    expect(composeCaption(["Only story here."])).toBe("Only story here.");
  });

  it("joins multiple summaries with a visible separator, in the given order", () => {
    const result = composeCaption(["First story.", "Second story.", "Third story.", "Fourth story."]);
    expect(result).toBe("First story.\n\n---\n\nSecond story.\n\n---\n\nThird story.\n\n---\n\nFourth story.");
  });
});

describe("truncateForPlatform", () => {
  it("returns a caption under the limit unchanged", () => {
    const caption = "Short caption.";
    expect(truncateForPlatform(caption, 2200)).toBe(caption);
  });

  it("returns a caption exactly at the limit unchanged", () => {
    const caption = "x".repeat(50);
    expect(truncateForPlatform(caption, 50)).toBe(caption);
  });

  it("truncates a caption over the limit and appends an ellipsis, staying within maxLength", () => {
    const caption = "word ".repeat(500).trim();
    const result = truncateForPlatform(caption, 100);

    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith("…")).toBe(true);
  });

  it("breaks on a word boundary rather than mid-word when a nearby space exists", () => {
    const caption = "The quick brown fox jumps over the lazy dog and keeps running for a very long time";
    const result = truncateForPlatform(caption, 40);

    expect(result.endsWith("…")).toBe(true);
    const withoutEllipsis = result.slice(0, -1);
    expect(withoutEllipsis.endsWith(" ")).toBe(false);
    expect(caption.startsWith(withoutEllipsis)).toBe(true);
  });

  // A four-story carousel caption assembled from four caption_summary fields can plausibly exceed
  // Instagram's ~2200-char limit even though it fits LinkedIn's larger one (Phase 2's own note).
  it("handles a 4-story composed caption over the Instagram limit", () => {
    const summaries = Array.from({ length: 4 }, (_, i) => `Story ${String(i + 1)}: `.padEnd(700, "lorem ipsum "));
    const composed = composeCaption(summaries);
    expect(composed.length).toBeGreaterThan(2200);

    const truncated = truncateForPlatform(composed, 2200);
    expect(truncated.length).toBeLessThanOrEqual(2200);
    expect(truncated.endsWith("…")).toBe(true);
  });
});
