// WORKER-SIDE. The single entry point every pipeline stage calls instead of the SDK. It enforces
// the per-digest spend ceiling, accounts the true cost of every call, and reports the outcome in
// the LlmResult idiom the rest of the codebase already branches on.
//
// The controlling idea (F-03): there is no vendor budget primitive, so the ceiling is a
// CHECK-BEFORE / ACCUMULATE-AFTER loop around each call. The check and the increment are separate
// round trips with the API call between them, so the ceiling is SOFT: it is not atomic across
// concurrent calls. Sequentially the overshoot is bounded by one call. Under concurrency — S-02's
// pattern, scoring a whole pool — N in-flight calls can all pass the check before any increments,
// so the real bound is `concurrency × max per-call cost`. `maxTokens` bounds each call's cost;
// bounded fan-out bounds the multiplier. A caller that scores a large pool (S-02) should cap its
// concurrency so `concurrency × per-call` stays small against the ceiling. The atomic RPC keeps
// the *accounting* exact (no lost increments); it does not make the *ceiling* hard.
//
// Phase 2 handled the ceiling, accounting, and stop-reason branching; Phase 3 adds schema-
// constrained output (output_config.format) with a single corrective reprompt, and up-front
// rejection of schema shapes the API cannot enforce.
import type {
  ContentBlock,
  JSONOutputFormat,
  MessageCreateParamsNonStreaming,
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { z } from "zod";

import type { LlmTransport } from "@/lib/llm/client";
import { costOf, DEFAULT_MODEL, type LlmModel, type TokenUsage } from "@/lib/llm/pricing";
import { toStructuredFormat } from "@/lib/llm/schema";
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

/** A request that constrains the response to a schema and returns the parsed value. */
export interface StructuredRequest<T> extends LlmRequest {
  schema: z.ZodType<T>;
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

/** A structured success also carries the schema-parsed value. */
export interface StructuredSuccess<T> extends LlmSuccess {
  parsed: T;
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

function buildParams(
  request: LlmRequest,
  model: LlmModel,
  messages: MessageParam[],
  format?: JSONOutputFormat,
): MessageCreateParamsNonStreaming {
  const params: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: request.maxTokens,
    messages,
  };
  if (request.system !== undefined) {
    params.system = request.cacheSystem
      ? ([{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }] satisfies TextBlockParam[])
      : request.system;
  }
  if (format) params.output_config = { format };
  return params;
}

/**
 * One call: ceiling check, the API call, cost accounting, stop-reason branch. Does not throw.
 *
 * Order is load-bearing: the ceiling is checked BEFORE the call (a digest already at its limit
 * makes no call at all), and the cost is accumulated AFTER the call regardless of whether the
 * response is usable — a refusal or a truncated response still bills, and the ceiling would be a
 * lie if those were not counted. The reprompt in `invoke` calls this a second time, so a retry is
 * ceiling-checked and accounted exactly like a first attempt.
 */
async function attemptCall(
  llm: LlmTransport,
  db: ServiceClient,
  digestId: string,
  model: LlmModel,
  params: MessageCreateParamsNonStreaming,
  ceilingUsd: number,
): Promise<LlmResult<LlmSuccess>> {
  const { data: digest, error: readError } = await db
    .from("digest")
    .select("cost_usd")
    .eq("id", digestId)
    .maybeSingle();
  if (readError) return err("api_error", `failed to read digest cost: ${readError.code}: ${readError.message}`);
  if (!digest) return err("api_error", `no digest with id ${digestId}`);
  if (digest.cost_usd >= ceilingUsd) {
    return err("ceiling_reached", `digest ${digestId} at $${digest.cost_usd} has reached the $${ceilingUsd} ceiling`);
  }

  let response;
  try {
    response = await llm.messages.create(params);
  } catch (error) {
    return err("api_error", errorMessage(error));
  }

  const usage = response.usage;
  const costUsd = costOf(usage, model);
  const accounted = await accountCost(db, digestId, costUsd);
  if (!accounted.ok) {
    // A billed call whose cost we could not record (after retries) leaves the ceiling
    // untrustworthy. Fail loudly rather than continue against a total that understates spend.
    return err("api_error", `cost accounting failed after a billed $${costUsd} call: ${accounted.message}`);
  }
  const totalCostUsd = accounted.total;

  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

  // Branch on stop_reason BEFORE reading content — a refusal returns 200 with possibly-empty
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
      return err("truncated", `response hit max_tokens (${params.max_tokens})`);
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

/**
 * Record a billed call's cost, retrying a transient write failure before giving up.
 *
 * The cost is already known and the money already spent by the time this runs, so losing the
 * write to a transient DB blip would understate spend and let a re-trigger re-spend. A missing
 * digest (data === null) is not transient — retrying cannot conjure the row — so it bails at once.
 * If every attempt fails, the caller still fails loudly rather than continuing against an
 * untrustworthy total.
 */
export async function accountCost(
  db: ServiceClient,
  digestId: string,
  costUsd: number,
): Promise<{ ok: true; total: number } | { ok: false; message: string }> {
  let lastMessage = "unknown accounting error";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await db.rpc("increment_digest_cost", { p_digest_id: digestId, p_delta: costUsd });
    if (!error && data !== null) return { ok: true, total: data };
    if (!error && data === null) return { ok: false, message: "digest not found" }; // not transient
    lastMessage = error?.message ?? "unknown accounting error";
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return { ok: false, message: lastMessage };
}

/** Parse a structured response body: JSON.parse, then validate against the schema. */
function validate<T>(schema: z.ZodType<T>, text: string): { ok: true; value: T } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `response was not valid JSON: ${errorMessage(error)}` };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: parsed.error.message };
}

export function invoke<T>(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  request: StructuredRequest<T>,
  options: InvokeOptions,
): Promise<LlmResult<StructuredSuccess<T>>>;
export function invoke(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  request: LlmRequest,
  options: InvokeOptions,
): Promise<LlmResult<LlmSuccess>>;
/**
 * Invoke the model for a digest, enforcing its ceiling and accounting the cost.
 *
 * With a `schema`, the response is constrained to it and parsed; a validation failure triggers ONE
 * corrective reprompt (the bad answer plus the error, fed back), and a second failure returns
 * `malformed_output`. Each attempt is a full call — ceiling-checked and accounted — so a run at its
 * limit does not get a free retry.
 */
export async function invoke<T>(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  request: LlmRequest | StructuredRequest<T>,
  options: InvokeOptions,
): Promise<LlmResult<LlmSuccess | StructuredSuccess<T>>> {
  const schema = "schema" in request ? request.schema : undefined;

  // Reject an unsupported schema before touching the client or the DB — a bad schema is a caller
  // bug that must surface in tests, not as a 400 mid-run.
  let format: JSONOutputFormat | undefined;
  if (schema) {
    const converted = toStructuredFormat(schema);
    if (!converted.ok) return err("api_error", converted.message);
    format = converted.format;
  }

  if (!llm) return err("not_configured", "no LLM client — ANTHROPIC_API_KEY is missing");

  const model = request.model ?? DEFAULT_MODEL;

  const first = await attemptCall(
    llm,
    db,
    digestId,
    model,
    buildParams(request, model, request.messages, format),
    options.ceilingUsd,
  );
  if (!first.ok) return first;
  if (!schema) return first;

  const firstParse = validate(schema, first.data.text);
  if (firstParse.ok) return { ok: true, data: { ...first.data, parsed: firstParse.value } };

  // One corrective reprompt: replay the bad answer and name what was wrong. A normal multi-turn
  // exchange (the trailing turn is the user's), not a prefill.
  const retryMessages: MessageParam[] = [
    ...request.messages,
    { role: "assistant", content: first.data.text },
    {
      role: "user",
      content: `Your previous response did not match the required schema: ${firstParse.message}. Respond again with only valid JSON matching the schema.`,
    },
  ];
  const second = await attemptCall(
    llm,
    db,
    digestId,
    model,
    buildParams(request, model, retryMessages, format),
    options.ceilingUsd,
  );
  if (!second.ok) return second;

  const secondParse = validate(schema, second.data.text);
  if (secondParse.ok) return { ok: true, data: { ...second.data, parsed: secondParse.value } };

  return err(
    "malformed_output",
    `output failed schema validation twice — [1] ${firstParse.message} [2] ${secondParse.message}`,
  );
}
