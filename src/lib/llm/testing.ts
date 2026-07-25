// Test support for the LLM harness: a client-shaped stub whose messages.create returns queued
// responses (or throws queued errors), so the ceiling, accounting, and recovery paths are
// deterministically testable without spending money.
//
// Response fixtures carry realistic `usage` objects with all four token fields, because the cost
// accounting is exactly what is under test. The only thing holding these shapes honest against the
// real API is the opt-in live smoke test (Phase 4) — if the SDK's Message shape drifts, this file
// and the harness drift together and only the live call notices.
import type { Message, StopReason, Usage } from "@anthropic-ai/sdk/resources/messages";

import type { LlmTransport } from "@/lib/llm/client";

export interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** A full SDK Usage from the fields the accounting reads; the rest default to null/zero. */
function usage(over: FakeUsage = {}): Usage {
  return {
    input_tokens: over.input_tokens ?? 0,
    output_tokens: over.output_tokens ?? 0,
    cache_creation_input_tokens: over.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: over.cache_read_input_tokens ?? null,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}

export interface FakeMessageOptions {
  text?: string;
  stopReason?: StopReason;
  usage?: FakeUsage;
  model?: string;
  refusalCategory?: "cyber" | "bio" | "frontier_llm" | "reasoning_extraction" | "general_harms";
}

/** Build a valid SDK Message. Defaults to a normal `end_turn` text response. */
export function fakeMessage(options: FakeMessageOptions = {}): Message {
  const stopReason = options.stopReason ?? "end_turn";
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: options.model ?? "claude-sonnet-5",
    content: options.text === undefined ? [] : [{ type: "text", text: options.text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details:
      stopReason === "refusal"
        ? { type: "refusal", category: options.refusalCategory ?? "general_harms", explanation: null }
        : null,
    container: null,
    usage: usage(options.usage),
  };
}

type QueuedOutcome = { kind: "message"; message: Message } | { kind: "error"; error: Error };

export interface FakeLlmTransport extends LlmTransport {
  /** Every request the harness passed to messages.create, in order. */
  readonly calls: unknown[];
}

/**
 * A transport that returns the queued outcomes in order. Queue Messages via fakeMessage(), or an
 * Error to simulate a transport failure. Running out of queued outcomes throws — a test that makes
 * more calls than it staged is a bug worth surfacing loudly.
 */
export function fakeLlmTransport(outcomes: (Message | Error)[]): FakeLlmTransport {
  const queue: QueuedOutcome[] = outcomes.map((o) =>
    o instanceof Error ? { kind: "error", error: o } : { kind: "message", message: o },
  );
  const calls: unknown[] = [];

  return {
    calls,
    messages: {
      create: ((params: unknown) => {
        calls.push(params);
        const next = queue.shift();
        if (!next) throw new Error("fakeLlmTransport: messages.create called more times than staged");
        if (next.kind === "error") return Promise.reject(next.error);
        return Promise.resolve(next.message);
      }) as LlmTransport["messages"]["create"],
    },
  };
}
