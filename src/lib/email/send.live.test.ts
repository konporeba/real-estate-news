// LIVE smoke test: one real email sent via Gmail SMTP. The mocked-transport suites in send.test.ts
// prove the harness handles the shape nodemailer's types promise; they cannot notice a bad App
// Password, Gmail rejecting the connection, or the real send()/sendMail() behavior drifting from
// those assumptions — exactly the class of failure the S-01 live smoke caught within minutes of
// existing.
//
// Opt-in via EMAIL_LIVE_SMOKE=1 plus GMAIL_USER, GMAIL_APP_PASSWORD, and OPERATOR_EMAIL, so CI
// stays hermetic and free and a routine `npm test` never sends real mail.
//
//   EMAIL_LIVE_SMOKE=1 npx vitest run src/lib/email/send.live.test.ts
import { describe, expect, it } from "vitest";

import { createEmailClient } from "@/lib/email/client";
import { sendEmail } from "@/lib/email/send";

const live = Boolean(
  process.env.EMAIL_LIVE_SMOKE === "1" &&
  process.env.GMAIL_USER &&
  process.env.GMAIL_APP_PASSWORD &&
  process.env.OPERATOR_EMAIL,
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the live smoke test`);
  return value;
}

describe.skipIf(!live)("sendEmail (live smoke)", () => {
  it("sends one real email via Gmail SMTP", async () => {
    const transport = createEmailClient({
      user: requireEnv("GMAIL_USER"),
      appPassword: requireEnv("GMAIL_APP_PASSWORD"),
    });

    const result = await sendEmail(transport, requireEnv("OPERATOR_EMAIL"), {
      subject: "[Real Estate News] F-04 live smoke test",
      content: {
        heading: "F-04 live smoke test",
        bodyHtml: "<p>This is an automated live smoke test of the outbound email harness. No action is needed.</p>",
      },
    });

    expect(result.ok, result.ok ? "" : `${result.reason}: ${result.message}`).toBe(true);
  }, 30_000);
});
