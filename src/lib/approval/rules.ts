// APP-SIDE. The single authority on what a valid approval decision is (FR-020).
//
// Both the decide API route and the approval island import this, so the operator's live
// affordance and the server's enforcement cannot disagree about the same rule. The island is a
// .tsx file and Vitest only collects `src/**/*.test.ts` (vitest.config.ts), so the rules live
// here in plain TypeScript where they can be tested; the island stays presentational.
//
// The DATABASE is authoritative, not this module: `record_approval` in
// supabase/migrations/20260912100000_approval_record.sql re-checks the note length and rejects
// with AG003. This layer exists to give the operator immediate feedback and to keep malformed
// JSON away from the database, not to be the only gate. `rules.test.ts` parses that migration and
// fails if the two ever drift — the same precedent src/lib/selection/rules.ts and
// src/lib/digest/state-machine.ts follow for their own gates.
import { z } from "zod";

import type { ApprovalDecision } from "@/types";

export const APPROVAL_DECISIONS = ["approved", "rejected"] as const satisfies readonly ApprovalDecision[];

/** Mirrored by the `approval_note_length` check constraint on the `approval` table. */
export const MAX_NOTE_LENGTH = 2000;

/** Human-facing labels for the island's controls; kept beside the vocabulary they name. */
export const DECISION_LABELS: Record<ApprovalDecision, string> = {
  approved: "Approve",
  rejected: "Reject",
};

/**
 * The decide endpoint's request body.
 *
 * `note` is optional and trimmed before the length check, so a note of only whitespace is treated
 * as absent rather than as a decision-carrying empty string — mirroring how an operator who
 * clears the textarea before submitting expects nothing to be recorded.
 */
export const approvalRequestSchema = z.object({
  digestId: z.uuid(),
  decision: z.enum(APPROVAL_DECISIONS),
  note: z
    .string()
    .trim()
    .max(MAX_NOTE_LENGTH, `note must be ${String(MAX_NOTE_LENGTH)} characters or fewer`)
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
});

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
