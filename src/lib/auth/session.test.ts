import { describe, expect, it } from "vitest";

import { createSessionToken, verifySessionToken } from "@/lib/auth/session";

describe("createSessionToken / verifySessionToken", () => {
  it("verifies a freshly created token", async () => {
    const token = await createSessionToken("secret-1", 60);
    await expect(verifySessionToken(token, "secret-1")).resolves.toBe(true);
  });

  it("rejects a token verified against a different secret", async () => {
    const token = await createSessionToken("secret-1", 60);
    await expect(verifySessionToken(token, "secret-2")).resolves.toBe(false);
  });

  it("rejects a tampered payload segment", async () => {
    const token = await createSessionToken("secret-1", 60);
    const [payloadSegment, signatureSegment] = token.split(".");
    const tampered = `${payloadSegment}x.${signatureSegment}`;
    await expect(verifySessionToken(tampered, "secret-1")).resolves.toBe(false);
  });

  it("rejects an expired token", async () => {
    const token = await createSessionToken("secret-1", -1);
    await expect(verifySessionToken(token, "secret-1")).resolves.toBe(false);
  });

  it("rejects a malformed token instead of throwing", async () => {
    await expect(verifySessionToken("not-a-valid-token", "secret-1")).resolves.toBe(false);
    await expect(verifySessionToken("", "secret-1")).resolves.toBe(false);
  });
});
