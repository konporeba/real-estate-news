import { describe, expect, it } from "vitest";

import { costOf, DEFAULT_MODEL, LLM_MODELS, MODEL_PRICES, type TokenUsage } from "@/lib/llm/pricing";

describe("MODEL_PRICES", () => {
  // Row 1.4: a model the config can select with no price entry would be accounted as $0 — the
  // silent failure this table exists to prevent. `satisfies Record<LlmModel, ...>` enforces this
  // at compile time; this asserts it at runtime too, so a bad refactor can't slip a gap through.
  it("has a price entry for every selectable model", () => {
    for (const model of LLM_MODELS) {
      expect(MODEL_PRICES[model], `no price for ${model}`).toBeDefined();
      expect(MODEL_PRICES[model].inputPerMTok).toBeGreaterThan(0);
      expect(MODEL_PRICES[model].outputPerMTok).toBeGreaterThan(0);
    }
  });

  it("the default model is priced", () => {
    expect(MODEL_PRICES[DEFAULT_MODEL]).toBeDefined();
  });

  it("carries a verified date on every entry, so staleness is visible", () => {
    for (const model of LLM_MODELS) {
      expect(MODEL_PRICES[model].verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("costOf", () => {
  const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  });

  it("prices uncached input and output at their own rates", () => {
    // Sonnet 5: $3/MTok in, $15/MTok out. 1M in + 1M out = $3 + $15 = $18.
    const cost = costOf(usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }), "claude-sonnet-5");
    expect(cost).toBeCloseTo(18, 10);
  });

  it("prices cache reads at the input rate times the read multiplier", () => {
    // 1M cache-read tokens at $3/MTok × 0.1 = $0.30.
    const cost = costOf(usage({ cache_read_input_tokens: 1_000_000 }), "claude-sonnet-5");
    expect(cost).toBeCloseTo(0.3, 10);
  });

  it("prices cache writes at the input rate times the write multiplier", () => {
    // 1M cache-write tokens at $3/MTok × 1.25 = $3.75.
    const cost = costOf(usage({ cache_creation_input_tokens: 1_000_000 }), "claude-sonnet-5");
    expect(cost).toBeCloseTo(3.75, 10);
  });

  it("sums all four token classes", () => {
    const cost = costOf(
      usage({
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      }),
      "claude-sonnet-5",
    );
    expect(cost).toBeCloseTo(18 + 0.3 + 3.75, 10);
  });

  it("treats null/undefined cache fields as zero", () => {
    const cost = costOf(
      { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      "claude-sonnet-5",
    );
    // 100 × ($3 + $15)/1e6 = 0.0018.
    expect(cost).toBeCloseTo(0.0018, 10);
  });

  it("differs by model — Opus costs more than Sonnet for the same usage", () => {
    const u = usage({ input_tokens: 500_000, output_tokens: 500_000 });
    expect(costOf(u, "claude-opus-4-8")).toBeGreaterThan(costOf(u, "claude-sonnet-5"));
  });

  // Row 1.5, documented from the pricing side: a realistic scoring call sits at cents, well above
  // the numeric(10,4) rounding floor ($0.00005) where the DB would store it as zero. The DB side
  // of the floor is asserted against the real column in cost-accounting.test.ts.
  it("a realistic Sonnet call lands well above the numeric(10,4) rounding floor", () => {
    // ~2k in, ~500 out — a modest scoring call.
    const cost = costOf(usage({ input_tokens: 2000, output_tokens: 500 }), "claude-sonnet-5");
    expect(cost).toBeGreaterThan(0.00005);
  });
});
