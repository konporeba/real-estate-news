// APP-SIDE. The single authority on what a valid story selection is (FR-012).
//
// Both the confirm API route and the selection island import this, so the operator's live
// affordance (a disabled submit button) and the server's enforcement cannot disagree about the
// same rule. The island is a .tsx file and Vitest only collects `src/**/*.test.ts`
// (vitest.config.ts), so the rules live here in plain TypeScript where they can be tested;
// the island stays presentational.
//
// The DATABASE is authoritative, not this module: `confirm_selection` in
// supabase/migrations/20260829120000_selection_gate.sql re-checks every rule below and rejects
// with SG003/SG004/SG005. This layer exists to give the operator immediate feedback and to keep
// malformed JSON away from the database, not to be the only gate. `rules.test.ts` parses that
// migration and fails if the two ever drift — update both together, exactly as
// src/lib/digest/state-machine.ts does for the transition map.
import { z } from "zod";

import type { SelectionFormat, SelectionPlatform } from "@/types";

/** FR-012: the operator selects between 2 and 4 stories. Mirrored in confirm_selection(). */
export const MIN_PICKS = 2;
export const MAX_PICKS = 4;

/** At least one target platform must be chosen. Mirrored by selection_platforms_not_empty. */
export const MIN_PLATFORMS = 1;

export const SELECTION_FORMATS = ["single_post", "carousel"] as const satisfies readonly SelectionFormat[];

export const SELECTION_PLATFORMS = [
  "instagram",
  "linkedin",
  "facebook",
] as const satisfies readonly SelectionPlatform[];

/** Human-facing labels for the island's controls; kept beside the vocabulary they name. */
export const FORMAT_LABELS: Record<SelectionFormat, string> = {
  single_post: "Single post",
  carousel: "Carousel",
};

export const PLATFORM_LABELS: Record<SelectionPlatform, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

export function isPickCountValid(count: number): boolean {
  return count >= MIN_PICKS && count <= MAX_PICKS;
}

/**
 * Whether the island may enable its submit control. Deliberately takes counts rather than the
 * arrays: the island holds its picks in a Set, and this keeps the rule in one place without
 * forcing a conversion at the call site.
 */
export function isSubmittable(pickedCount: number, platformCount: number): boolean {
  return isPickCountValid(pickedCount) && platformCount >= MIN_PLATFORMS;
}

/**
 * The confirm endpoint's request body.
 *
 * The shortlist is part of the request, not re-derived server-side, so what the operator actually
 * saw is what gets labeled — see the note in confirm_selection(). Refinements run in order, so
 * the operator gets the most specific complaint first: shape, then duplicates, then count, then
 * membership.
 */
export const selectionRequestSchema = z
  .object({
    digestId: z.uuid(),
    shortlistClusterIds: z.array(z.uuid()).min(1, "the shortlist must not be empty"),
    pickedClusterIds: z.array(z.uuid()),
    format: z.enum(SELECTION_FORMATS),
    platforms: z.array(z.enum(SELECTION_PLATFORMS)).min(MIN_PLATFORMS, "choose at least one platform"),
  })
  .refine((value) => new Set(value.shortlistClusterIds).size === value.shortlistClusterIds.length, {
    message: "the shortlist contains duplicate cluster ids",
    path: ["shortlistClusterIds"],
  })
  .refine((value) => new Set(value.pickedClusterIds).size === value.pickedClusterIds.length, {
    message: "the same story was selected twice",
    path: ["pickedClusterIds"],
  })
  .refine((value) => isPickCountValid(value.pickedClusterIds.length), {
    message: `select between ${MIN_PICKS} and ${MAX_PICKS} stories`,
    path: ["pickedClusterIds"],
  })
  .refine(
    (value) => {
      const shortlist = new Set(value.shortlistClusterIds);
      return value.pickedClusterIds.every((id) => shortlist.has(id));
    },
    {
      message: "every selected story must be on the shortlist",
      path: ["pickedClusterIds"],
    },
  );

export type SelectionRequest = z.infer<typeof selectionRequestSchema>;
