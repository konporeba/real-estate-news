// WORKER-SIDE. The single entry point every pipeline stage calls instead of the SDK. It enforces
// the per-digest spend ceiling, accounts the true cost of every call, and reports the outcome in
// the LlmResult idiom the rest of the codebase already branches on.
//
// The controlling idea (F-03): there is no vendor budget primitive, so the ceiling is a
// CHECK-BEFORE / ACCUMULATE-AFTER loop around each call. Enforcement granularity is one call;
// `maxTokens` bounds the overshoot of the call already in flight.
//
// Phase 2 handles the ceiling, accounting, and stop-reason branching. Schema-constrained output
// and one-reprompt recovery land in Phase 3 (the `schema` field on the request is added there).
import type {
  ContentBlock,
  MessageCreateParamsNonStreaming,
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

import type { LlmTransport } from "@/lib/llm/client";
import { costOf, DEFAULT_MODEL, type LlmModel, type TokenUsage } from "@/lib/llm/pricing";
import type { ServiceClient } from "@/lib/supabase-service";
import type { LlmError, LlmErrorReason, LlmResult } from "@/types";

export interface LlmRequest {
  /** Defaults to DEFAULT_MODEL (Sonnet 5). */
  model?: LlmModel;
  system?: string;
  messages: MessageParam[];
  maxTokens: number;
  /**
   * Put a cache breakpoint on the system prompt. Use for a large, stable prefix reused across
   * calls (S-02's rubric) — cache reads bill at ~0.1x. Below the model's minimum cacheable prefix
   * (2048 tokens on Sonnet 5) it silently does not cache; check the returned cache token counts.
   */
  cacheSystem?: boolean;
}

export interface LlmSuccess {
  /** Concatenated text blocks — the usual payload. Raw `content` is alongside for the rest. */
  text: string;
  content: ContentBlock[];
  model: LlmModel;
  usage: TokenUsage;
  /** USD this call cost. */
  costUsd: number;
  /** The digest's running total after this call was accounted. */
  totalCostUsd: number;
  /** From `usage` — so callers can verify caching actually engaged rather than assume it. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface InvokeOptions {
  ceilingUsd: number;
}

function err(reason: LlmErrorReason, message: string): LlmError {
  return { ok: false, reason, message };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function buildParams(request: LlmRequest, model: LlmModel): MessageCreateParamsNonStreaming {
  const params: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: request.maxTokens,
    messages: request.messages,
  };
  if (request.system !== undefined) {
    params.system = request.cacheSystem
      ? ([{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }] satisfies TextBlockParam[])
      : request.system;
  }
  return params;
}

/**
 * Invoke the model for a digest, enforcing its ceiling and accounting the cost.
 *
 * Order is load-bearing: the ceiling is checked BEFORE the call (a digest already at its limit
 * makes no call at all), and the cost is accumulated AFTER the call regardless of whether the
 * response is usable — a refusal or a truncated response still bills, and the ceiling would be a
 * lie if those were not counted.
 */
export async function invoke(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  request: LlmRequest,
  options: InvokeOptions,
): Promise<LlmResult<LlmSuccess>> {
  if (!llm) return err("not_configured", "no LLM client — ANTHROPIC_API_KEY is missing");

  const model = request.model ?? DEFAULT_MODEL;

  // 1. Ceiling check — read the running total and refuse before spending anything more.
  const { data: digest, error: readError } = await db
    .from("digest")
    .select("cost_usd")
    .eq("id", digestId)
    .maybeSingle();
  if (readError) return err("api_error", `failed to read digest cost: ${readError.code}: ${readError.message}`);
  if (!digest) return err("api_error", `no digest with id ${digestId}`);
  if (digest.cost_usd >= options.ceilingUsd) {
    return err(
      "ceiling_reached",
      `digest ${digestId} at $${digest.cost_usd} has reached the $${options.ceilingUsd} ceiling`,
    );
  }

  // 2. The call. A transport failure (after the SDK's own retries) is an api_error, not a throw.
  let response;
  try {
    response = await llm.messages.create(buildParams(request, model));
  } catch (error) {
    return err("api_error", errorMessage(error));
  }

  // 3. Account the cost ALWAYS — before deciding whether the response is usable.
  const usage = response.usage;
  const costUsd = costOf(usage, model);
  const { data: totalCostUsd, error: acctError } = await db.rpc("increment_digest_cost", {
    p_digest_id: digestId,
    p_delta: costUsd,
  });
  if (acctError || totalCostUsd === null) {
    // A billed call whose cost we could not record leaves the ceiling untrustworthy. Fail loudly
    // rather than continue against a total that understates real spend.
    return err(
      "api_error",
      `cost accounting failed after a billed $${costUsd} call: ${acctError?.message ?? "digest not found"}`,
    );
  }

  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

  // 4. Branch on stop_reason BEFORE reading content — a refusal returns 200 with possibly-empty
  // content, and indexing it blindly would crash.
  switch (response.stop_reason) {
    case "end_turn":
    case "stop_sequence":
      return {
        ok: true,
        data: {
          text: textOf(response.content),
          content: response.content,
          model,
          usage,
          costUsd,
          totalCostUsd,
          cacheReadTokens,
          cacheCreationTokens,
        },
      };
    case "refusal": {
      const category = response.stop_details?.category;
      return err("refusal", `model refused${category ? ` (${category})` : ""}`);
    }
    case "max_tokens":
      return err("truncated", `response hit max_tokens (${request.maxTokens})`);
    case "model_context_window_exceeded":
      return err("context_exceeded", "prompt exceeded the model context window");
    case "pause_turn":
      return err("api_error", "unexpected pause_turn (no server-side tools are used in this slice)");
    case "tool_use":
      return err("api_error", "unexpected tool_use (no tools are defined in this slice)");
    default:
      return err("api_error", `unexpected stop_reason: ${String(response.stop_reason)}`);
  }
}
