// WORKER-SIDE. The validated shape of `digest.collection_report`.
//
// The column is jsonb, so the database cannot enforce this — it is deliberately schema-less
// there because the per-source entry list will change as the api and rendered tiers land,
// and absorbing that without a migration is the point. Validation lives here instead.
//
// What the report is FOR: making a thin week explainable from the digest row alone (US-03).
// When the operator opens Monday's shortlist and finds four stories instead of fifteen, the
// answer — which sources failed, which returned nothing, whether fallbacks were reached —
// has to be in the row, because worker logs may have rotated away by then.
//
// `version` is a discriminator, not decoration: reports written this week are read back
// months later by the archive (S-09), so a v1 reader must keep working after v2 exists.
import { z } from "zod";

import { SOURCE_ROLES, SOURCE_TIERS } from "@/lib/collection/sources";

export const COLLECTION_REPORT_VERSION = 1;

/** Per-source outcome. `skipped` means not attempted (fallback on a healthy week). */
export const SOURCE_STATUSES = ["ok", "failed", "skipped"] as const;

export const sourceReportSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(SOURCE_ROLES),
  tier: z.enum(SOURCE_TIERS),
  status: z.enum(SOURCE_STATUSES),
  /** Candidates the adapter returned, before window filtering. */
  itemsFetched: z.number().int().min(0),
  /** Rows actually inserted — lower than fetched on a re-trigger, where dedupe absorbs the rest. */
  itemsInserted: z.number().int().min(0),
  /** Present only for `failed`; the adapter's error message, already stringified. */
  error: z.string().nullable(),
  durationMs: z.number().int().min(0),
});

export const collectionReportSchema = z.object({
  version: z.literal(COLLECTION_REPORT_VERSION),
  /** The resolved cutoff bounds this run actually used, as ISO instants. */
  window: z.object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  sources: z.array(sourceReportSchema),
  /** Distinct articles in the digest after this run — the number the operator feels. */
  poolSize: z.number().int().min(0),
  /** Whether poolSize reached MIN_POOL_SIZE. False is the signal that explains a thin week. */
  thresholdMet: z.boolean(),
  /** Whether the FR-003 fallback escalation was triggered. */
  fallbacksRan: z.boolean(),
  /**
   * FR-003's last resort is an AI web search, which needs the F-03 cost ceiling before it
   * can run unattended. Recorded explicitly rather than omitted, so a thin week is never
   * mistaken for "we tried everything".
   */
  aiWebSearchSkipped: z.literal(true),
  completedAt: z.iso.datetime(),
});

export type SourceReport = z.infer<typeof sourceReportSchema>;
export type CollectionReport = z.infer<typeof collectionReportSchema>;

/**
 * Parse a report read back from the database.
 *
 * Returns null rather than throwing: a malformed or future-version report must not break
 * the dashboard reading it. The caller renders "no report" instead of crashing on a row
 * whose only job is diagnostics.
 */
export function parseCollectionReport(value: unknown): CollectionReport | null {
  const result = collectionReportSchema.safeParse(value);
  return result.success ? result.data : null;
}
