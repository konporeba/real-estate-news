import { describe, expect, it } from "vitest";

import { createEmailClient } from "@/lib/email/client";

describe("createEmailClient", () => {
  it("returns null when config is null", () => {
    expect(createEmailClient(null)).toBeNull();
  });

  it("returns a transport exposing sendMail when configured", () => {
    const transport = createEmailClient({ user: "sender@example.com", appPassword: "app-password" });
    expect(transport).not.toBeNull();
    expect(typeof transport?.sendMail).toBe("function");
  });
});
