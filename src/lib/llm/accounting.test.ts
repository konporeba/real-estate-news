// Unit tests for accountCost's retry behavior (F-03 impl-review F2). The real DB never fails the
// increment in the happy path, so the retry-on-transient-failure and don't-retry-a-missing-digest
// branches are only reachable with a stub. No SUPABASE gating — these are pure and fast.
import { describe, expect, it, vi } from "vitest";

import { accountCost } from "@/lib/llm/invoke";
import type { ServiceClient } from "@/lib/supabase-service";

interface RpcResult {
  data: number | null;
  error: { message: string } | null;
}

/** A ServiceClient stub exposing only rpc(), which returns the queued results in order. */
function stubDb(results: RpcResult[]): { db: ServiceClient; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn().mockImplementation(() => {
    const next = results.shift();
    if (!next) throw new Error("stubDb: rpc called more times than staged");
    return Promise.resolve(next);
  });
  return { db: { rpc } as unknown as ServiceClient, rpc };
}

describe("accountCost", () => {
  it("returns the total on a first-try success", async () => {
    const { db, rpc } = stubDb([{ data: 0.42, error: null }]);

    const result = await accountCost(db, "id", 0.42);

    expect(result).toEqual({ ok: true, total: 0.42 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure, then succeeds", async () => {
    const { db, rpc } = stubDb([
      { data: null, error: { message: "connection reset" } },
      { data: null, error: { message: "connection reset" } },
      { data: 0.9, error: null },
    ]);

    const result = await accountCost(db, "id", 0.3);

    expect(result).toEqual({ ok: true, total: 0.9 });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("gives up after three transient failures, carrying the last error", async () => {
    const { db, rpc } = stubDb([
      { data: null, error: { message: "blip 1" } },
      { data: null, error: { message: "blip 2" } },
      { data: null, error: { message: "blip 3" } },
    ]);

    const result = await accountCost(db, "id", 0.3);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("blip 3");
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("does not retry a missing digest (null with no error is not transient)", async () => {
    const { db, rpc } = stubDb([{ data: null, error: null }]);

    const result = await accountCost(db, "id", 0.3);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("digest not found");
    expect(rpc).toHaveBeenCalledTimes(1); // bailed immediately, no wasted retries
  });
});
