// The app-side twin of the digest state machine.
//
// The database is AUTHORITATIVE: the `enforce_digest_transition` BEFORE UPDATE trigger
// in supabase/migrations/*_digest_core_schema.sql rejects illegal moves even if a worker
// misbehaves. This module mirrors that map so the app can guard early and drive UX
// without a round trip. `state-machine.test.ts` parses the migration and fails if the
// two ever drift — update both together.
import type { DigestStatus } from "@/types";

export type { DigestStatus };

/** Legal `from → to` moves. Must stay identical to the trigger's allowed map. */
export const TRANSITIONS: Record<DigestStatus, readonly DigestStatus[]> = {
  collecting: ["ranking", "failed"],
  ranking: ["ready_for_selection", "failed"],
  ready_for_selection: ["generating", "skipped", "failed"],
  // S-06: generation hands off to the rendering stage, not straight to the approval gate.
  generating: ["rendering", "failed"],
  rendering: ["ready_for_approval", "failed"],
  // S-07: `rejected` is deliberately separate from `skipped` -- `skipped` is US-19's
  // missed-deadline state and stays manually publishable (skipped -> published). A digest the
  // operator rejected must never be publishable, and S-08 must be able to tell the two apart.
  ready_for_approval: ["approved", "rejected", "skipped", "failed"],
  approved: ["published", "skipped", "failed"],
  // US-19: a missed-deadline digest stays manually publishable.
  skipped: ["published"],
  // S-07: the sole recovery path out of a rejection -- fresh copy on the same confirmed
  // selection, mirroring `failed -> generating` (S-05 impl-review F2). Never publishable
  // directly.
  rejected: ["generating"],
  // FR-018: re-trigger a failed run in place -- from the top for a collection failure, from
  // the selection gate's output for a generation failure (S-05 impl-review F2), which would
  // otherwise discard the confirmed selection and re-pay the whole ranking stage, or from the
  // generated copy for a render failure (S-06), which costs nothing to redo.
  failed: ["collecting", "generating", "rendering"],
  published: [],
};

/**
 * States that end a run. These are exactly the states excluded from the
 * `one_active_digest_per_week` partial unique index, so a week in one of them can be
 * re-triggered. `skipped` and `failed` keep a single manual escape hatch (see
 * TRANSITIONS) — terminal here means "no longer occupies the week", not "frozen".
 */
export const TERMINAL_STATES = [
  "published",
  "skipped",
  "failed",
  "rejected",
] as const satisfies readonly DigestStatus[];

export function isTerminal(status: DigestStatus): boolean {
  return (TERMINAL_STATES as readonly DigestStatus[]).includes(status);
}

/**
 * Whether `from → to` is a legal move. A no-op (`from === to`) is not a transition and
 * returns false; the database trigger likewise skips validation rather than allowing it,
 * so callers should read state and decide instead of re-transitioning.
 */
export function canTransition(from: DigestStatus, to: DigestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
