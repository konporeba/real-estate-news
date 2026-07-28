// WORKER-SIDE. The single entry point for sending a notification. Validates the recipient, calls
// the transport, and reports the outcome in the EmailResult idiom — never throws, matching
// invoke()'s contract that an unattended run must not die on an uncaught error.
//
// No ceiling, no accounting, no retry: unlike the LLM harness (F-03), a single email send has no
// per-call cost to bound, so one attempt and a clear typed failure is the whole contract.
import { z } from "zod";

import type { EmailTransport } from "@/lib/email/client";
import { type EmailContent, renderEmailHtml, renderEmailText } from "@/lib/email/layout";
import type { EmailError, EmailErrorReason, EmailResult } from "@/types";

export interface EmailRequest {
  subject: string;
  content: EmailContent;
}

const emailAddress = z.email();

function err(reason: EmailErrorReason, message: string): EmailError {
  return { ok: false, reason, message };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Send a notification email. Order is load-bearing: configuration and recipient shape are
 * checked BEFORE touching the network, so a missing credential or a typo'd address never spends
 * a real SMTP round trip.
 */
export async function sendEmail(
  transport: EmailTransport | null,
  to: string | undefined,
  request: EmailRequest,
): Promise<EmailResult> {
  if (!transport || !to) return err("not_configured", "no email transport or recipient configured");

  const parsedTo = emailAddress.safeParse(to);
  if (!parsedTo.success) return err("invalid_recipient", `"${to}" is not a valid email address`);

  try {
    await transport.sendMail({
      to,
      subject: request.subject,
      html: renderEmailHtml(request.content),
      text: renderEmailText(request.content),
    });
    return { ok: true };
  } catch (error) {
    return err("send_failed", errorMessage(error));
  }
}
