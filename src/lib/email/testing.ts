// Test support for the email harness: a transport-shaped stub whose sendMail returns queued
// outcomes (or throws queued errors), so send.ts's branches are deterministically testable
// without sending real mail. Mirrors src/lib/llm/testing.ts's fakeLlmTransport.
import type { EmailTransport } from "@/lib/email/client";

type QueuedOutcome = { kind: "sent" } | { kind: "error"; error: Error };

export interface FakeEmailTransport extends EmailTransport {
  /** Every options object the harness passed to sendMail, in order. */
  readonly calls: unknown[];
}

/**
 * A transport that resolves/rejects the queued outcomes in order. Queue `true` for a successful
 * send, or an Error to simulate a transport failure. Running out of queued outcomes throws — a
 * test that makes more calls than it staged is a bug worth surfacing loudly.
 */
export function fakeEmailTransport(outcomes: (true | Error)[]): FakeEmailTransport {
  const queue: QueuedOutcome[] = outcomes.map((o) =>
    o instanceof Error ? { kind: "error", error: o } : { kind: "sent" },
  );
  const calls: unknown[] = [];

  return {
    calls,
    sendMail: ((options: unknown) => {
      calls.push(options);
      const next = queue.shift();
      if (!next) throw new Error("fakeEmailTransport: sendMail called more times than staged");
      if (next.kind === "error") return Promise.reject(next.error);
      return Promise.resolve({ messageId: "fake" });
    }) as EmailTransport["sendMail"],
  };
}
