// WORKER-SIDE. Constructs the Gmail SMTP transport without reading any environment of its own,
// mirroring src/lib/llm/client.ts so this module resolves in the worker and in Vitest alike.
// The worker builds the credentials from src/worker/env.ts and passes them in.
//
// Gmail requires an App Password, not the account password, for SMTP auth — the sending account
// must have 2-Step Verification enabled to generate one (see .env.example).
import nodemailer from "nodemailer";

// Cached per user, like supabase-service caches per credential pair — the transport holds no
// per-request state, so one instance is shared.
const cache = new Map<string, EmailTransport>();

/**
 * The narrow slice of nodemailer's Transporter the harness depends on. Both the real transport
 * and the test fake satisfy it, which is what lets sendEmail() be tested without sending mail.
 */
export interface EmailTransport {
  sendMail: Pick<nodemailer.Transporter, "sendMail">["sendMail"];
}

export interface GmailConfig {
  user: string;
  appPassword: string;
}

/**
 * Build (or reuse) a Gmail SMTP transport. Returns null when config is absent — the
 * createLlmClient precedent — so the caller surfaces `not_configured` instead of letting an SMTP
 * auth error escape into an unattended run.
 */
export function createEmailClient(config: GmailConfig | null): EmailTransport | null {
  if (!config) return null;

  let transport = cache.get(config.user);
  if (!transport) {
    // `defaults` sets `from` on every send made through this transport, so callers never need
    // to know or repeat the sending address.
    transport = nodemailer.createTransport(
      { service: "gmail", auth: { user: config.user, pass: config.appPassword } },
      { from: config.user },
    );
    cache.set(config.user, transport);
  }
  return transport;
}
