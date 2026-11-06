import { describe, expect, it, vi } from "vitest";

import type { ServiceClient } from "@/lib/supabase-service";
import { tick } from "@/worker/watch";

const client = {} as ServiceClient;

describe("tick", () => {
  it("runs the advance job once", async () => {
    const advance = vi.fn().mockResolvedValue({ ok: true });

    await tick(client, advance);

    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(client);
  });

  it("survives a pass that throws, so the session keeps running", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(tick(client, vi.fn().mockRejectedValue(new Error("database down")))).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(expect.stringContaining("database down"));
    errors.mockRestore();
  });

  it("reports a week that failed without stopping", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await tick(client, vi.fn().mockResolvedValue({ ok: false, error: "week 2026-11-02: boom" }));

    expect(errors).toHaveBeenCalledWith(expect.stringContaining("week 2026-11-02: boom"));
    errors.mockRestore();
  });
});
