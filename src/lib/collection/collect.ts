// WORKER-SIDE. The collection stage: everything between "a digest exists in `collecting`"
// and "the digest is in `ranking` or `failed`".
//
// The controlling idea is that PARTIAL FAILURE IS THE EXPECTED PATH. Spanish news sites
// block scrapers, rate-limit, and time out; a run that aborted because one source misbehaved
// would fail most weeks. So every source is fetched inside its own error boundary and the
// orchestrator's job is to compose successes and record failures (US-03) — an adapter
// exception must never reach the caller.
//
// The only genuine failure is an EMPTY pool: there is nothing for S-02 to rank, so the
// digest goes to `failed` with a diagnostic rather than advancing silently into a stage
// that would produce an empty shortlist.
import { adapterFor } from "@/lib/collection/adapters";
import type { Candidate, FetchWindow } from "@/lib/collection/adapters/types";
import { COLLECTION_REPORT_VERSION, type CollectionReport, type SourceReport } from "@/lib/collection/report";
import {
  MAX_ITEMS_PER_SOURCE,
  MIN_POOL_SIZE,
  SOURCES,
  sourcesForRole,
  type SourceDefinition,
  type SourceRole,
} from "@/lib/collection/sources";
import { resolveCollectionWindow } from "@/lib/collection/window";
import { markStageComplete, transitionDigest } from "@/lib/digest/run-state";
import type { ServiceClient } from "@/lib/supabase-service";
import type { DigestRun, RunStateResult } from "@/types";

/** How many sources are fetched at once. Small on purpose: these are someone else's servers. */
const FETCH_CONCURRENCY = 4;

export interface CollectOptions {
  /** Overridable for tests; defaults to the shipped registry. */
  sources?: SourceDefinition[];
  /** Run start — also the window's upper bound. */
  now?: Date;
}

export interface CollectOutcome {
  digest: DigestRun;
  report: CollectionReport;
}

interface SourceOutcome {
  report: SourceReport;
  candidates: Candidate[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Fetch one source, converting any failure into a recorded outcome.
 *
 * This function does not throw. That is the entire per-source isolation guarantee, and it
 * is why the try/catch wraps the adapter call rather than living in the caller's loop.
 */
async function collectFromSource(source: SourceDefinition, window: FetchWindow): Promise<SourceOutcome> {
  const startedAt = Date.now();
  const base = { slug: source.slug, name: source.name, role: source.role, tier: source.tier };

  try {
    const candidates = await adapterFor(source)(source, window);
    const withinWindow = candidates.filter((candidate) => inWindow(candidate, window)).slice(0, MAX_ITEMS_PER_SOURCE);

    return {
      candidates: withinWindow,
      report: {
        ...base,
        status: "ok",
        itemsFetched: candidates.length,
        itemsInserted: 0, // filled in after the insert, which is batched across sources
        error: null,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    return {
      candidates: [],
      report: {
        ...base,
        status: "failed",
        itemsFetched: 0,
        itemsInserted: 0,
        error: errorMessage(error),
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

/**
 * The authoritative window filter — adapters are advisory (see adapters/types.ts).
 *
 * An undated candidate is KEPT. Feeds list recent content, so a missing date is far more
 * often a feed quirk than an old story, and silently dropping those items would lose
 * stories the operator wanted with no trace. The blast radius is bounded by
 * MAX_ITEMS_PER_SOURCE rather than by the date filter.
 */
function inWindow(candidate: Candidate, window: FetchWindow): boolean {
  if (!candidate.publishedAt) return true;
  const at = candidate.publishedAt.getTime();
  return at >= window.from.getTime() && at < window.to.getTime();
}

/** Run tasks with a bounded number in flight. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Insert candidates, ignoring rows whose URL is already in this digest.
 *
 * `ignoreDuplicates` against `unique (digest_id, source_url)` is what makes a re-trigger
 * (FR-018) a TOP-UP rather than a duplicate-or-wipe decision: what the failed attempt
 * collected stays, and only genuinely new URLs are added. Returns the number inserted.
 */
async function insertCandidates(
  client: ServiceClient,
  digestId: string,
  entries: { source: SourceDefinition; candidate: Candidate }[],
): Promise<RunStateResult<number>> {
  if (entries.length === 0) return { ok: true, data: 0 };

  // Postgres rejects a statement that touches the same conflict key twice, so an identical
  // URL syndicated by two sources in one batch has to be collapsed before it reaches the DB.
  const seen = new Set<string>();
  const rows = entries
    .filter(({ candidate }) => {
      if (seen.has(candidate.sourceUrl)) return false;
      seen.add(candidate.sourceUrl);
      return true;
    })
    .map(({ source, candidate }) => ({
      digest_id: digestId,
      source_name: source.name,
      source_url: candidate.sourceUrl,
      published_at: candidate.publishedAt?.toISOString() ?? null,
      original_title: candidate.title,
      original_lede: candidate.lede,
    }));

  // upsert + ignoreDuplicates is ON CONFLICT DO NOTHING; `insert` has no such option.
  // Rows already present are left untouched and omitted from the returned set, so the
  // count below is genuinely "newly added" rather than "attempted".
  const { data, error } = await client
    .from("article")
    .upsert(rows, { onConflict: "digest_id,source_url", ignoreDuplicates: true })
    .select("id");

  if (error) {
    // A batch failure must not abort the run — the pool already persisted is worth more
    // than the rows this statement lost.
    return { ok: false, reason: "database_error", message: `${error.code}: ${error.message}` };
  }
  return { ok: true, data: data.length };
}

/** Fetch every source of a role and attribute the inserted count back to each. */
async function collectRole(
  client: ServiceClient,
  digestId: string,
  role: SourceRole,
  window: FetchWindow,
  sources: SourceDefinition[],
): Promise<{ reports: SourceReport[]; inserted: number }> {
  const selected = sourcesForRole(role, sources);
  if (selected.length === 0) return { reports: [], inserted: 0 };

  const outcomes = await mapWithConcurrency(selected, FETCH_CONCURRENCY, (source) => collectFromSource(source, window));

  let inserted = 0;
  for (const [index, outcome] of outcomes.entries()) {
    const result = await insertCandidates(
      client,
      digestId,
      outcome.candidates.map((candidate) => ({ source: selected[index], candidate })),
    );

    if (result.ok) {
      outcome.report.itemsInserted = result.data;
      inserted += result.data;
    } else {
      // The fetch succeeded; persistence did not. Record it against the source so the
      // report explains a thin week rather than showing a healthy fetch and a small pool.
      outcome.report.status = "failed";
      outcome.report.error = result.message;
    }
  }

  return { reports: outcomes.map((outcome) => outcome.report), inserted };
}

/** Distinct articles currently attached to the digest — the number the operator feels. */
async function poolSize(client: ServiceClient, digestId: string): Promise<RunStateResult<number>> {
  const { count, error } = await client
    .from("article")
    .select("id", { count: "exact", head: true })
    .eq("digest_id", digestId);

  if (error) return { ok: false, reason: "database_error", message: `${error.code}: ${error.message}` };
  return { ok: true, data: count ?? 0 };
}

/**
 * Run collection for a digest that is in `collecting`.
 *
 * Ends by moving the digest to `ranking` (pool non-empty) or `failed` (pool empty). The
 * report is written BEFORE the transition so a digest that ends up in `failed` still
 * carries the explanation of why.
 */
export async function collect(
  client: ServiceClient,
  digest: DigestRun,
  options: CollectOptions = {},
): Promise<RunStateResult<CollectOutcome>> {
  const sources = options.sources ?? SOURCES;
  const now = options.now ?? new Date();

  const windowResult = await resolveCollectionWindow(client, digest, now);
  if (!windowResult.ok) return windowResult;
  const window = windowResult.data;

  const primary = await collectRole(client, digest.id, "primary", window, sources);
  const reports = [...primary.reports];

  // FR-003: escalate only when the primary pool came in thin. On a normal week the
  // fallback sources are never touched, keeping request volume down on the ones most
  // likely to start blocking.
  let sized = await poolSize(client, digest.id);
  if (!sized.ok) return sized;

  const fallbacksRan = sized.data < MIN_POOL_SIZE;
  if (fallbacksRan) {
    const fallback = await collectRole(client, digest.id, "fallback", window, sources);
    reports.push(...fallback.reports);

    sized = await poolSize(client, digest.id);
    if (!sized.ok) return sized;
  } else {
    for (const source of sourcesForRole("fallback", sources)) {
      reports.push({
        slug: source.slug,
        name: source.name,
        role: source.role,
        tier: source.tier,
        status: "skipped",
        itemsFetched: 0,
        itemsInserted: 0,
        error: null,
        durationMs: 0,
      });
    }
  }

  // FR-003's last resort is an AI web search. It would be the system's first model spend,
  // and F-03's cost ceiling does not exist yet — so it is deliberately not attempted, and
  // the report says so rather than staying silent. See roadmap F-03.
  const aiWebSearchSkipped = true as const;

  const report: CollectionReport = {
    version: COLLECTION_REPORT_VERSION,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    sources: reports,
    poolSize: sized.data,
    thresholdMet: sized.data >= MIN_POOL_SIZE,
    fallbacksRan,
    aiWebSearchSkipped,
    completedAt: new Date().toISOString(),
  };

  const { error: reportError } = await client.from("digest").update({ collection_report: report }).eq("id", digest.id);

  if (reportError) {
    return { ok: false, reason: "database_error", message: `${reportError.code}: ${reportError.message}` };
  }

  if (sized.data === 0) {
    const failed = await transitionDigest(client, digest.id, "failed", {
      lastError: `collection produced no articles: ${reports.filter((r) => r.status === "failed").length} of ${reports.length} sources failed`,
    });
    if (!failed.ok) return failed;
    return { ok: true, data: { digest: failed.data, report } };
  }

  const checkpointed = await markStageComplete(client, digest.id, "collection", now);
  if (!checkpointed.ok) return checkpointed;

  const ranked = await transitionDigest(client, digest.id, "ranking");
  if (!ranked.ok) return ranked;

  return { ok: true, data: { digest: ranked.data, report } };
}
