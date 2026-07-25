// WORKER-SIDE. The per-model price table and the cost function the ceiling multiplies by.
//
// There is no vendor budget primitive (see the F-03 decision record in the change folder), so
// the ceiling is application-side arithmetic: token `usage` from every response, times the rates
// below. This module owns the multiplicand.
//
// PRICES ARE STICKER, NOT THE INTRODUCTORY RATE. Sonnet 5 lists at $3/$15 per million tokens with
// an introductory $2/$10 running through 2026-08-31. Encoding the intro rate would make the
// ceiling LOOSER than reality once it lapses — a run would spend past its limit believing it had
// not. Sticker over-counts during the intro window, which binds the ceiling slightly early; that
// is the safe direction for a spend guard. Update the `verified` note whenever a rate is checked.
import { z } from "zod";

/** Exact Anthropic model IDs. Do not append date suffixes — these strings are complete. */
export const LLM_MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"] as const;
export type LlmModel = (typeof LLM_MODELS)[number];

/** The pipeline's default, per the F-03 plan: Sonnet 5 across ranking and generation. */
export const DEFAULT_MODEL: LlmModel = "claude-sonnet-5";

const modelPriceSchema = z.object({
  /** USD per million input tokens (uncached). */
  inputPerMTok: z.number().positive(),
  /** USD per million output tokens. */
  outputPerMTok: z.number().positive(),
  /** Multiplier on the input rate for tokens read from cache (~0.1x). */
  cacheReadMultiplier: z.number().positive(),
  /** Multiplier on the input rate for tokens written to cache (1.25x at the 5-minute TTL). */
  cacheWriteMultiplier: z.number().positive(),
  /** Date the rate was last checked against the vendor, YYYY-MM-DD. */
  verified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type ModelPrice = z.infer<typeof modelPriceSchema>;

// `satisfies` forces compile-time completeness: a model added to LLM_MODELS without a price entry
// is a type error here, not a silent $0 at runtime. The zod parse below adds value validation
// (a negative or malformed rate) on top of that.
const PRICES_RAW = {
  "claude-sonnet-5": {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    verified: "2026-07-24",
  },
  "claude-opus-4-8": {
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    verified: "2026-07-24",
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    verified: "2026-07-24",
  },
} satisfies Record<LlmModel, ModelPrice>;

// Validates every value at import for its throw side-effect; a bad rate stops the module from
// loading before any run can mis-bill against it. Completeness is already guaranteed by the
// `satisfies` above, so the validated literal is exported directly.
z.record(z.enum(LLM_MODELS), modelPriceSchema).parse(PRICES_RAW);
export const MODEL_PRICES: Record<LlmModel, ModelPrice> = PRICES_RAW;

/**
 * The four token counts every Claude response reports. Cache fields are nullable because the SDK
 * returns them as `number | null` when caching is not in play. Declared here rather than imported
 * from the SDK so this module — and the ceiling math — stays SDK-free (the dependency lands in
 * Phase 2). The SDK's own `Usage` type is structurally compatible.
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Unrounded USD cost of one response. The four token classes bill independently: uncached input
 * and output at their own rates, cache reads and cache writes at the input rate times their
 * multiplier. Returns full JS precision — the `numeric(10,4)` column rounds on store (a delta
 * below $0.00005 becomes zero), which is a documented limit, not this function's concern.
 */
export function costOf(usage: TokenUsage, model: LlmModel): number {
  // `model` is typed to LLM_MODELS and MODEL_PRICES is total over it, so this is always defined.
  const price = MODEL_PRICES[model];

  const perToken = price.inputPerMTok / 1_000_000;
  const outputPerToken = price.outputPerMTok / 1_000_000;

  return (
    usage.input_tokens * perToken +
    usage.output_tokens * outputPerToken +
    (usage.cache_read_input_tokens ?? 0) * perToken * price.cacheReadMultiplier +
    (usage.cache_creation_input_tokens ?? 0) * perToken * price.cacheWriteMultiplier
  );
}
