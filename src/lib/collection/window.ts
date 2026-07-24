// WORKER-SIDE. Resolves the time span a collection run covers.
//
// The controlling idea is TILING: consecutive digests must cover the calendar exactly
// once — no gap that silently loses a story, no overlap that re-collects one. So the
// lower bound is not "this digest's Monday" but "where the previous run actually
// stopped", which is the previous digest's `collection_completed_at` checkpoint.
//
// That is what resolves roadmap OQ#7 ("late-Sunday news") without a declared cutoff: a
// story published at 23:50 on Sunday falls after this run's upper bound, so it is picked
// up by the next run rather than dropped. There is no window to shrink and no rule to
// keep in sync — the checkpoint is the boundary.
//
// All calendar math is done in a NAMED ZONE (Europe/Warsaw), never a fixed offset, so the
// DST transitions do not shift week boundaries by an hour. Intl is the whole mechanism;
// no date library is needed for this.
import type { DigestRun, DigestWindow, RunStateResult } from "@/types";
import type { FetchWindow } from "@/lib/collection/adapters/types";
import type { ServiceClient } from "@/lib/supabase-service";

/** The operator's zone. Every week boundary and day boundary is computed in it. */
export const COLLECTION_TIMEZONE = "Europe/Warsaw";

const MS_PER_DAY = 86_400_000;

const zonedFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: COLLECTION_TIMEZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of an instant as seen in COLLECTION_TIMEZONE. */
function zonedParts(instant: Date): ZonedParts {
  const parts = zonedFormatter.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`Intl did not return a "${type}" part`);
    // "24" is how hour12:false renders midnight in some ICU versions.
    return Number(found.value) % (type === "hour" ? 24 : Number.MAX_SAFE_INTEGER);
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** The zone's UTC offset (ms) at a given instant — positive east of Greenwich. */
function offsetAt(instant: Date): number {
  const p = zonedParts(instant);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/** `YYYY-MM-DD` as the date reads in the zone at that instant. */
export function zonedDateString(instant: Date): string {
  const { year, month, day } = zonedParts(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The instant at which a calendar date begins (00:00) in the zone.
 *
 * Resolved in two passes: guess using the offset at UTC midnight, then re-check the offset
 * at the candidate instant. The second pass is what makes a DST-transition date correct,
 * since the offset before and after the change differ.
 */
export function startOfDayInZone(date: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(guess.getTime())) throw new Error(`invalid date: ${date}`);

  const firstPass = new Date(guess.getTime() - offsetAt(guess));
  const secondOffset = offsetAt(firstPass);
  return new Date(guess.getTime() - secondOffset);
}

/** Add whole calendar days to a `YYYY-MM-DD` string. DST-free: pure date arithmetic. */
function addDays(date: string, days: number): string {
  const shifted = new Date(new Date(`${date}T00:00:00Z`).getTime() + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The Monday–Sunday week containing `instant`, as the date pair `createDigest` wants.
 * Monday-based because the digest publishes on Tuesday: the week under review is the one
 * that has just closed.
 */
export function currentWeekWindow(instant: Date = new Date()): DigestWindow {
  const today = zonedDateString(instant);
  const dayOfWeek = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const start = addDays(today, -daysSinceMonday);
  return { start, end: addDays(start, 6) };
}

/**
 * Pure lower/upper bound resolution — the part worth testing exhaustively.
 *
 * `previousCheckpoint` is the previous digest's `collection_completed_at`, or null when
 * this is the first run (or the previous run never completed collection). Falling back to
 * this digest's own `window_start` at local midnight is deliberately conservative: it may
 * re-offer an article the previous run already saw, and the insert's ON CONFLICT dedupe
 * absorbs that. The opposite error — a gap — would lose a story silently.
 */
export function collectionWindowFrom(previousCheckpoint: string | null, windowStart: string, now: Date): FetchWindow {
  return {
    from: previousCheckpoint ? new Date(previousCheckpoint) : startOfDayInZone(windowStart),
    to: now,
  };
}

/**
 * Resolve the window for a digest, reading the previous digest's checkpoint.
 *
 * The digest's OWN checkpoint is never consulted. On a re-trigger (FR-018) this digest may
 * already carry a `collection_completed_at` from the failed attempt; honouring it would
 * shrink the window to "since my last try" and permanently lose everything the failed run
 * did not persist. The previous digest is the boundary, always.
 */
export async function resolveCollectionWindow(
  client: ServiceClient,
  digest: Pick<DigestRun, "window_start">,
  now: Date = new Date(),
): Promise<RunStateResult<FetchWindow>> {
  const { data, error } = await client
    .from("digest")
    .select("collection_completed_at")
    .lt("window_start", digest.window_start)
    .not("collection_completed_at", "is", null)
    .order("window_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { ok: false, reason: "database_error", message: `${error.code}: ${error.message}` };
  }

  return { ok: true, data: collectionWindowFrom(data?.collection_completed_at ?? null, digest.window_start, now) };
}
