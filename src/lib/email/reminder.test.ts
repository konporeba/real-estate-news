// Unit tests for the FR-021 Monday reminder. No transport and no network: the builder is a pure
// function, mirroring digest-ready.test.ts and approval-ready.test.ts.
import { describe, expect, it } from "vitest";

import { buildReminderEmail } from "@/lib/email/reminder";
import type { OutstandingGate, OutstandingGateKind } from "@/lib/approval/outstanding";
import type { DigestRun } from "@/types";

function digest(overrides: Partial<DigestRun> = {}): DigestRun {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    window_start: "2026-08-24",
    window_end: "2026-08-30",
    status: "ready_for_approval",
    cost_usd: 0,
    collection_completed_at: null,
    ranking_completed_at: null,
    translation_completed_at: null,
    generation_completed_at: null,
    rendering_completed_at: null,
    last_error: null,
    collection_report: null,
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
    ...overrides,
  };
}

function gate(kind: OutstandingGateKind, overrides: Partial<DigestRun> = {}): OutstandingGate {
  return {
    digest: digest({ status: kind === "selection" ? "ready_for_selection" : "ready_for_approval", ...overrides }),
    gate: kind,
  };
}

describe("buildReminderEmail", () => {
  it("throws rather than building a hollow email for an empty list", () => {
    expect(() => buildReminderEmail([], "https://news.example")).toThrow(/no outstanding gates/);
  });

  it("names the single outstanding step in the subject", () => {
    const email = buildReminderEmail([gate("approval")], undefined);

    expect(email.subject).toContain("Awaiting approval");
    expect(email.subject).toContain("2026-08-24");
  });

  it("uses a count-based subject for more than one outstanding digest", () => {
    const email = buildReminderEmail(
      [gate("approval"), gate("selection", { id: "2", window_start: "2026-09-01" })],
      undefined,
    );

    expect(email.subject).toContain("2 digests");
  });

  it("names the selection gate", () => {
    const email = buildReminderEmail([gate("selection")], undefined);

    expect(email.content.bodyHtml).toContain("Awaiting story selection");
  });

  it("names the approval gate", () => {
    const email = buildReminderEmail([gate("approval")], undefined);

    expect(email.content.bodyHtml).toContain("Awaiting approval");
  });

  it("links a selection gate to the shortlist page", () => {
    const email = buildReminderEmail([gate("selection")], "https://news.example");

    expect(email.content.bodyHtml).toContain(`https://news.example/dashboard/${digest().id}"`);
    expect(email.content.bodyHtml).not.toContain("/approve");
  });

  it("links an approval gate to the approve page, not the digest page", () => {
    const email = buildReminderEmail([gate("approval")], "https://news.example");

    expect(email.content.bodyHtml).toContain(`https://news.example/dashboard/${digest().id}/approve`);
  });

  it("does not double the slash when the base URL has a trailing one", () => {
    const email = buildReminderEmail([gate("approval")], "https://news.example/");

    expect(email.content.bodyHtml).toContain(`https://news.example/dashboard/${digest().id}/approve`);
    expect(email.content.bodyHtml).not.toContain("news.example//dashboard");
  });

  it("names each digest's week without a link when no base URL is configured", () => {
    const email = buildReminderEmail([gate("approval")], undefined);

    expect(email.content.bodyHtml).toContain("2026-08-24");
    expect(email.content.bodyHtml).not.toContain("<a ");
  });

  it("lists every outstanding digest, oldest first as the caller ordered them", () => {
    const older = gate("selection", { id: "a", window_start: "2026-08-01" });
    const newer = gate("approval", { id: "b", window_start: "2026-08-08" });

    const html = buildReminderEmail([older, newer], undefined).content.bodyHtml;
    expect(html.indexOf("2026-08-01")).toBeLessThan(html.indexOf("2026-08-08"));
  });
});
