// The one shape every collection tier implements, so the orchestrator is written once and
// the api / rendered tiers slot in later without touching it (FR-002).
import type { SourceDefinition, SourceTier } from "@/lib/collection/sources";

/** A normalized article candidate, before it becomes an `article` row. */
export interface Candidate {
  /** Canonical article URL. Doubles as the dedupe key via unique(digest_id, source_url). */
  sourceUrl: string;
  title: string;
  /** Lede / summary / meta description. FR-006 scores on title AND lede, never title alone. */
  lede: string | null;
  /** Null when the feed omits or malforms the date — kept rather than dropped, see below. */
  publishedAt: Date | null;
}

/** The resolved collection window. Bounds are inclusive of `from`, exclusive of `to`. */
export interface FetchWindow {
  from: Date;
  to: Date;
}

/**
 * Fetches candidates for one source.
 *
 * The window is advisory: tiers that can push date filtering to the server (a news API)
 * should use it, while a feed adapter simply returns what the feed holds. The orchestrator
 * performs the authoritative window filter either way, so an adapter is never the last
 * word on what falls inside the week.
 *
 * Adapters throw on failure and never swallow errors — isolating a blocked source so it
 * cannot fail the run (US-03) is the orchestrator's job, and an adapter that returned an
 * empty array on error would be indistinguishable from a quiet source.
 */
export type FetchAdapter = (source: SourceDefinition, window: FetchWindow) => Promise<Candidate[]>;

/** Thrown when a source is configured for a tier that has no implementation yet. */
export class TierNotImplementedError extends Error {
  readonly tier: SourceTier;
  readonly slug: string;

  constructor(tier: SourceTier, slug: string) {
    super(`collection tier "${tier}" is not implemented yet (source: ${slug})`);
    this.name = "TierNotImplementedError";
    this.tier = tier;
    this.slug = slug;
  }
}
