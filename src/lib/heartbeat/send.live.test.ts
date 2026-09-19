// LIVE smoke test: one real ping sent to the operator's healthchecks.io check. The fake-fetch
// suite in send.test.ts proves the harness handles the shape a Response promises; it cannot
// notice a bad/expired ping URL or healthchecks.io's real API drifting from those assumptions.
//
// Opt-in via HEARTBEAT_LIVE_SMOKE=1 plus HEARTBEAT_PING_URL, so CI stays hermetic and a routine
// `npm test` never pings a real monitor.
//
//   HEARTBEAT_LIVE_SMOKE=1 npx vitest run src/lib/heartbeat/send.live.test.ts
import { describe, expect, it } from "vitest";

import { sendHeartbeat } from "@/lib/heartbeat/send";

const live = Boolean(process.env.HEARTBEAT_LIVE_SMOKE === "1" && process.env.HEARTBEAT_PING_URL);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the live smoke test`);
  return value;
}

describe.skipIf(!live)("sendHeartbeat (live smoke)", () => {
  it("sends one real ping to the configured healthchecks.io check", async () => {
    const result = await sendHeartbeat(fetch, requireEnv("HEARTBEAT_PING_URL"), { ok: true });

    expect(result.ok, result.ok ? "" : `${result.reason}: ${result.message}`).toBe(true);
  }, 30_000);
});
