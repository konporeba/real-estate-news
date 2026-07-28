// Unit tests for the send harness. The transport is a fake (no network, no real mail) — the
// branches under test are the not_configured / invalid_recipient / send_failed / success contract.
import { describe, expect, it } from "vitest";

import { fakeEmailTransport } from "@/lib/email/testing";
import { sendEmail } from "@/lib/email/send";

const REQUEST = {
  subject: "Test subject",
  content: { heading: "Test heading", bodyHtml: "<p>Body</p>" },
};

describe("sendEmail", () => {
  it("returns not_configured when the transport is null", async () => {
    const result = await sendEmail(null, "operator@example.com", REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
  });

  it("returns not_configured when the recipient is undefined", async () => {
    const transport = fakeEmailTransport([true]);
    const result = await sendEmail(transport, undefined, REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
    expect(transport.calls).toHaveLength(0);
  });

  it("returns not_configured when the recipient is an empty string", async () => {
    const transport = fakeEmailTransport([true]);
    const result = await sendEmail(transport, "", REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
    expect(transport.calls).toHaveLength(0);
  });

  it("returns invalid_recipient for a malformed address, without touching the transport", async () => {
    const transport = fakeEmailTransport([true]);
    const result = await sendEmail(transport, "not-an-email", REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_recipient");
      expect(result.message).toContain("not-an-email");
    }
    expect(transport.calls).toHaveLength(0);
  });

  it("returns send_failed with the underlying message when the transport rejects", async () => {
    const transport = fakeEmailTransport([new Error("invalid_grant")]);
    const result = await sendEmail(transport, "operator@example.com", REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("send_failed");
      expect(result.message).toContain("invalid_grant");
    }
  });

  it("sends the rendered content and returns ok on success", async () => {
    const transport = fakeEmailTransport([true]);
    const result = await sendEmail(transport, "operator@example.com", REQUEST);
    expect(result).toEqual({ ok: true });
    expect(transport.calls).toHaveLength(1);

    const call = transport.calls[0] as { to: string; subject: string; html: string; text: string };
    expect(call.to).toBe("operator@example.com");
    expect(call.subject).toBe("Test subject");
    expect(call.html).toContain("Test heading");
    expect(call.html).toContain("<p>Body</p>");
    expect(call.text).toContain("Test heading");
  });
});
