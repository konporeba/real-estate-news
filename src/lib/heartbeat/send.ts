// WORKER-SIDE. S-10/FR-028: a dead-man's-switch ping to an external monitor (healthchecks.io), so
// silence from the home server surfaces as an alert instead of being mistaken for "no news".
//
// No SDK, no client to construct — the ping URL itself is the only credential, so unlike
// src/lib/email or src/lib/llm there is no separate client.ts: the URL is read straight from
// worker env and passed in here. Never throws, matching sendEmail()'s contract that a
// notification side-channel must not fail the run it reports on.
import type { HeartbeatResult } from "@/types";

/**
 * healthchecks.io's own ping API convention: a check's failure URL is always its success URL with
 * `/fail` appended. This is a healthchecks.io-specific assumption baked in deliberately (see the
 * plan's Critical Implementation Details) — swapping monitor providers later needs a code change
 * here, not just a new HEARTBEAT_PING_URL value.
 */
function urlFor(pingUrl: string, outcome: { ok: boolean }): string {
  return outcome.ok ? pingUrl : `${pingUrl}/fail`;
}

/** Ping the configured dead-man's-switch. One attempt, no retry — the next tick is the retry. */
export async function sendHeartbeat(
  fetchImpl: typeof fetch,
  pingUrl: string | undefined,
  outcome: { ok: boolean },
): Promise<HeartbeatResult> {
  if (!pingUrl) return { ok: false, reason: "not_configured", message: "no heartbeat ping URL configured" };

  try {
    const response = await fetchImpl(urlFor(pingUrl, outcome));
    if (!response.ok) {
      return { ok: false, reason: "send_failed", message: `heartbeat ping returned ${String(response.status)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "send_failed", message: error instanceof Error ? error.message : String(error) };
  }
}
