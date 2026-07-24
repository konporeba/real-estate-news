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
  generating: ["ready_for_approval", "failed"],
  ready_for_approval: ["approved", "skipped", "failed"],
  approved: ["published", "skipped", "failed"],
  // US-19: a missed-deadline digest stays manually publishable.
  skipped: ["published"],
  // FR-018: re-trigger a failed run in place.
  failed: ["collecting"],
  published: [],
};

/**
 * States that end a run. These are exactly the states excluded from the
 * `one_active_digest_per_week` partial unique index, so a week in one of them can be
 * re-triggered. `skipped` and `failed` keep a single manual escape hatch (see
 * TRANSITIONS) — terminal here means "no longer occupies the week", not "frozen".
 */
export const TERMINAL_STATES = ["published", "skipped", "failed"] as const satisfies readonly DigestStatus[];

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
