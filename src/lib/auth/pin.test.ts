import { describe, expect, it } from "vitest";

import { hashPin, verifyPin } from "@/lib/auth/pin";

describe("hashPin / verifyPin", () => {
  it("verifies the correct PIN against its own hash", async () => {
    const hash = await hashPin("123456", "pepper-1");
    await expect(verifyPin("123456", "pepper-1", hash)).resolves.toBe(true);
  });

  it("rejects a wrong PIN", async () => {
    const hash = await hashPin("123456", "pepper-1");
    await expect(verifyPin("000000", "pepper-1", hash)).resolves.toBe(false);
  });

  it("rejects the correct PIN hashed under a different pepper", async () => {
    const hash = await hashPin("123456", "pepper-1");
    await expect(verifyPin("123456", "pepper-2", hash)).resolves.toBe(false);
  });

  it("is deterministic for the same PIN and pepper", async () => {
    const a = await hashPin("123456", "pepper-1");
    const b = await hashPin("123456", "pepper-1");
    expect(a).toBe(b);
  });
});
