// Unit tests for the heartbeat harness. fetchImpl is a fake (no network) — the branches under
// test are the not_configured / success / fail-suffix / non-2xx / thrown-error contract.
import { describe, expect, it, vi } from "vitest";

import { sendHeartbeat } from "@/lib/heartbeat/send";

const okResponse = () => new Response(null, { status: 200 });

describe("sendHeartbeat", () => {
  it("returns not_configured when pingUrl is undefined, without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await sendHeartbeat(fetchImpl, undefined, { ok: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("GETs the plain ping URL on a successful outcome", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());

    const result = await sendHeartbeat(fetchImpl, "https://hc-ping.com/abc", { ok: true });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith("https://hc-ping.com/abc");
  });

  it("GETs the /fail-suffixed URL on a failed outcome", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());

    const result = await sendHeartbeat(fetchImpl, "https://hc-ping.com/abc", { ok: false });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith("https://hc-ping.com/abc/fail");
  });

  it("returns send_failed with the status when the response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    const result = await sendHeartbeat(fetchImpl, "https://hc-ping.com/abc", { ok: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("send_failed");
      expect(result.message).toContain("500");
    }
  });

  it("returns send_failed with the underlying message when fetch rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await sendHeartbeat(fetchImpl, "https://hc-ping.com/abc", { ok: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("send_failed");
      expect(result.message).toContain("ECONNREFUSED");
    }
  });
});
