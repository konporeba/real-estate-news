// WORKER-SIDE. One story in, one Polish adaptation out, through F-03's invoke().
//
// ONE CALL PER STORY, deliberately. score-clusters.ts batches because it faces 250 clusters and
// the call count is the cost driver; here there are 2-4 stories a week, so batching would buy
// nothing and cost isolation: a story whose copy fails the numeric gate is retried on its own
// rather than dragging three good stories through a re-run. It also keeps each call's context to
// a single article body.
import { z } from "zod";

import type { LlmTransport } from "@/lib/llm/client";
import { invoke } from "@/lib/llm/invoke";
import { DEFAULT_MODEL, type LlmModel } from "@/lib/llm/pricing";
import {
  buildGenerationPrompt,
  GENERATION_SYSTEM,
  KEY_STATISTICS_MAX,
  KEY_STATISTICS_MIN,
  type GenerationStory,
} from "@/lib/generation/prompt";
import type { ServiceClient } from "@/lib/supabase-service";
import type { KeyStatistic, LlmResult, SelectionFormat } from "@/types";

/**
 * The generation model, named separately from DEFAULT_MODEL on purpose.
 *
 * Sonnet 5 today: the operator chose to ship on the pipeline default and compare Opus against
 * real published output rather than guessing before any copy exists. Because the choice lives in
 * this one constant, running that comparison is a one-line change — and if Opus wins, only
 * `claude-opus-5` needs adding to src/lib/llm/pricing.ts for the ceiling to account for it.
 */
export const GENERATION_MODEL: LlmModel = DEFAULT_MODEL;

/**
 * Output budget per story.
 *
 * Sized with real headroom, because thinking is LEFT ON for this call and `maxTokens` caps
 * thinking plus visible output together (src/lib/llm/invoke.ts). Clustering disables thinking —
 * a mechanical partition needs no deliberation and the hidden reasoning was eating the budget
 * meant for JSON. Copywriting is the opposite case: the deliberation is the point. A carousel of
 * five slides plus a title, summary and five statistics is perhaps 1200 visible tokens, so this
 * leaves the model several times that to think in before anything truncates.
 */
const MAX_TOKENS = 8000;

export interface GeneratedCopy {
  polishTitle: string;
  captionSummary: string;
  bodyCopy: string;
  keyStatistics: KeyStatistic[];
}

/**
 * No length or count constraints in the schema: F-03's harness rejects those (the API's structured
 * output does not support them), so the bounds are asked for in the prompt and the count is
 * checked below.
 */
const generatedCopySchema = z.object({
  polishTitle: z.string(),
  captionSummary: z.string(),
  bodyCopy: z.string(),
  keyStatistics: z.array(z.object({ label: z.string(), value: z.string() })),
});

export interface GenerateCopyOptions {
  ceilingUsd: number;
  /** Extra guidance appended to the prompt — the numeric gate's corrective retry uses this. */
  correction?: string;
}

/**
 * Generate one story's Polish social copy.
 *
 * Returns the harness's own failure reasons unchanged (`ceiling_reached`, `malformed_output`,
 * `refusal`, ...) so the orchestrator decides what a failure means for the digest — the harness
 * never transitions state and neither does this.
 */
export async function generateCopy(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  story: GenerationStory,
  format: SelectionFormat,
  options: GenerateCopyOptions,
): Promise<LlmResult<GeneratedCopy>> {
  const prompt = options.correction
    ? `${buildGenerationPrompt(story, format)}\n\n${options.correction}`
    : buildGenerationPrompt(story, format);

  const result = await invoke(
    llm,
    db,
    digestId,
    {
      model: GENERATION_MODEL,
      system: GENERATION_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      maxTokens: MAX_TOKENS,
      schema: generatedCopySchema,
    },
    { ceilingUsd: options.ceilingUsd },
  );
  if (!result.ok) return result;

  const copy = result.data.parsed;

  // Schema-valid but empty is still unusable: a blank title or body would reach the S-07 approval
  // gate looking like a publishable post. The column constraints are NOT NULL, not non-empty, so
  // this is the layer that catches it.
  if (!copy.polishTitle.trim() || !copy.captionSummary.trim() || !copy.bodyCopy.trim()) {
    return {
      ok: false,
      reason: "malformed_output",
      message: "generation returned an empty title, summary or body",
    };
  }

  // An over-long statistics list is the model ignoring the bound rather than the story being
  // rich; trim rather than fail, since the copy itself is fine. A short list is legitimate — the
  // prompt explicitly prefers fewer to invented ones — so it is accepted as-is.
  const keyStatistics = copy.keyStatistics.slice(0, KEY_STATISTICS_MAX);

  return {
    ok: true,
    data: { ...copy, keyStatistics },
  };
}

/** Bounds re-exported so the orchestrator and tests reference one definition. */
export { KEY_STATISTICS_MAX, KEY_STATISTICS_MIN };
