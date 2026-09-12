// WORKER-SIDE. FR-021's Monday reminder — the third real caller of the F-04 email harness.
//
// A pure function on purpose, mirroring digest-ready.ts and approval-ready.ts: it takes the
// outstanding gates and returns an EmailRequest, so the mapping is testable without a transport.
import { renderArticleCards, type ArticleCard } from "@/lib/email/layout";
import type { EmailRequest } from "@/lib/email/send";
import type { OutstandingGate, OutstandingGateKind } from "@/lib/approval/outstanding";

const GATE_LABELS: Record<OutstandingGateKind, string> = {
  selection: "Awaiting story selection",
  approval: "Awaiting approval",
};

function windowOf(gate: OutstandingGate): string {
  return `${gate.digest.window_start} – ${gate.digest.window_end}`;
}

/** The shortlist for a selection gate, the approval page for an approval gate (US-17). */
function pathFor(gate: OutstandingGate): string {
  return gate.gate === "selection" ? `/dashboard/${gate.digest.id}` : `/dashboard/${gate.digest.id}/approve`;
}

function toCard(gate: OutstandingGate, baseUrl?: string): ArticleCard {
  return {
    title: windowOf(gate),
    description: GATE_LABELS[gate.gate],
    url: baseUrl ? `${baseUrl.replace(/\/+$/, "")}${pathFor(gate)}` : undefined,
  };
}

/**
 * Build the Monday reminder. `gates` must be non-empty — an empty list is a programming error the
 * caller (the scheduled job) prevents by checking first and returning early rather than sending a
 * reminder that names nothing; this function throws rather than silently emitting a hollow email.
 *
 * `baseUrl` is optional exactly as it is for the other two notifications: without
 * `DASHBOARD_BASE_URL` the operator gets the outstanding weeks named in the email with no links,
 * rather than links pointing nowhere.
 */
export function buildReminderEmail(gates: OutstandingGate[], baseUrl?: string): EmailRequest {
  // .at(0) rather than [0]: the array is typed non-empty by convention (the caller checks first),
  // but an empty array is not structurally impossible, and .at()'s `| undefined` return type is
  // what keeps this guard meaningful to both the compiler and the linter — astro/tsconfigs/strict
  // omits noUncheckedIndexedAccess, so a bare `gates[0]` would type as always-present and the
  // dead-code linter would (correctly, given that typing) flag the guard below as unreachable.
  const first = gates.at(0);
  if (!first) {
    throw new Error("buildReminderEmail called with no outstanding gates");
  }

  const subject =
    gates.length === 1
      ? `Reminder: ${GATE_LABELS[first.gate]} — ${windowOf(first)}`
      : `Reminder: ${String(gates.length)} digests awaiting a decision`;

  const intro =
    `<p style="margin: 0 0 20px;">` +
    (gates.length === 1
      ? "This digest is still waiting on you."
      : `These ${String(gates.length)} digests are still waiting on you.`) +
    `</p>`;

  return {
    subject,
    content: {
      heading: "A decision is waiting",
      bodyHtml: intro + renderArticleCards(gates.map((gate) => toCard(gate, baseUrl))),
    },
  };
}
