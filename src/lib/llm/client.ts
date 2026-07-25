// WORKER-SIDE. Constructs the Anthropic client without reading any environment of its own,
// mirroring src/lib/supabase-service.ts so this module resolves in the worker and in Vitest alike.
// The worker builds the key from src/worker/env.ts and passes it in.
//
// WORST-CASE WALL CLOCK PER CALL is `timeout × (maxRetries + 1)`, not `timeout`: the SDK retries
// timeouts (and 408/409/429/5xx). At the defaults below that is 60s × 3 = 3 minutes per call
// before it gives up — the number an unattended Sunday run is actually exposed to, across however
// many calls a stage makes. Raise the timeout, not the retries, if a stage needs longer.
import Anthropic from "@anthropic-ai/sdk";

/** Milliseconds — the TypeScript SDK's unit (Python/Ruby use seconds). */
const DEFAULT_TIMEOUT_MS = 60_000;
/** SDK default; stated explicitly because it is load-bearing for the worst-case above. */
const MAX_RETRIES = 2;

// Cached per (key, timeout) like supabase-service caches per credential pair — the client holds no
// per-request state, so one instance is shared. The key is in-memory only.
const cache = new Map<string, Anthropic>();

/**
 * The narrow slice of the SDK the harness depends on. Both the real client and the test mock
 * satisfy it, which is what lets invoke() be tested without spending money.
 */
export interface LlmTransport {
  messages: Pick<Anthropic["messages"], "create">;
}

/**
 * Build (or reuse) an Anthropic client. Returns null when the key is empty — the
 * createServiceClient precedent — so the caller surfaces `not_configured` instead of letting an
 * SDK auth error escape several stages into a run.
 */
export function createLlmClient(apiKey: string, options: { timeoutMs?: number } = {}): LlmTransport | null {
  if (!apiKey) return null;

  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheKey = `${apiKey}:${timeout}`;

  let client = cache.get(cacheKey);
  if (!client) {
    client = new Anthropic({ apiKey, timeout, maxRetries: MAX_RETRIES });
    cache.set(cacheKey, client);
  }
  return client;
}
