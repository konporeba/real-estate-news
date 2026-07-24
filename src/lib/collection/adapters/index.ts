// Tier registry. Total over SourceTier so an enabled source on an unimplemented tier
// fails loudly with a named error rather than being silently skipped — a silently skipped
// source looks exactly like a quiet news week, which is the ambiguity this pipeline is
// built to avoid.
import { rssAdapter } from "@/lib/collection/adapters/rss";
import { type FetchAdapter, TierNotImplementedError } from "@/lib/collection/adapters/types";
import type { SourceDefinition, SourceTier } from "@/lib/collection/sources";

const notImplemented =
  (tier: SourceTier): FetchAdapter =>
  (source) =>
    Promise.reject(new TierNotImplementedError(tier, source.slug));

/**
 * FR-002's three tiers. Only `rss` is implemented: the vendor choice for an aggregator
 * (`api`) and a rendered fetch (`rendered`) stays open until the source list shows which
 * sources actually need them — currently Cinco Días, El Economista and Idealista.
 */
const ADAPTERS: Record<SourceTier, FetchAdapter> = {
  rss: rssAdapter,
  api: notImplemented("api"),
  rendered: notImplemented("rendered"),
};

export function adapterFor(source: SourceDefinition): FetchAdapter {
  return ADAPTERS[source.tier];
}

export { TierNotImplementedError };
export type { Candidate, FetchWindow, FetchAdapter } from "@/lib/collection/adapters/types";
