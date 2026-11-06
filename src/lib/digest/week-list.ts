// The dashboard's "Previous weeks" list: which weeks a filter shows and one page of them. Shared by
// the server-rendered first page (src/pages/dashboard.astro) and the JSON endpoint the list island
// calls to switch filters without a reload (src/pages/api/digests.ts), so the two can never show
// different weeks for the same filter. Takes its client as a parameter, like the rest of
// src/lib/digest/, so both runtimes can use it.
import { z } from "zod";

import { NEEDS_OPERATOR_STATUSES } from "@/lib/digest/presentation";
import type { ServiceClient } from "@/lib/supabase-service";
import type { DigestStatus } from "@/types";

export const WEEK_PAGE_SIZE = 25;

export type WeekView = "all" | "needs" | "published";

export const WEEK_VIEWS: readonly { id: WeekView; label: string; statuses: DigestStatus[] | null }[] = [
  { id: "all", label: "All", statuses: null },
  { id: "needs", label: "Needs me", statuses: NEEDS_OPERATOR_STATUSES },
  { id: "published", label: "Published", statuses: ["approved", "published"] },
];

/** One row of the list — only what the row shows (and, later, what its actions need). */
export interface WeekRow {
  id: string;
  window_start: string;
  window_end: string;
  status: DigestStatus;
  last_error: string | null;
  updated_at: string;
}

export const WEEK_ROW_COLUMNS = "id, window_start, window_end, status, last_error, updated_at";

export interface WeekPage {
  weeks: WeekRow[];
  /** The cursor for "Show older weeks", or null on the last page. */
  nextBefore: string | null;
}

/**
 * The list query's input. A malformed `view` falls back to "all" and a malformed cursor to the
 * first page, rather than surfacing as an error — the same leniency the page always had for a
 * hand-edited URL.
 */
export const weekPageQuerySchema = z.object({
  view: z.enum(["all", "needs", "published"]).catch("all").default("all"),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .catch(null)
    .default(null),
  // The "this week" card's digest, shown above the list rather than in it.
  exclude: z.uuid().nullable().catch(null).default(null),
});

export type WeekPageQuery = z.infer<typeof weekPageQuerySchema>;

/** Reads the list query from URL search params (the page's own URL, or the endpoint's). */
export function parseWeekPageQuery(params: URLSearchParams): WeekPageQuery {
  return weekPageQuerySchema.parse({
    view: params.get("view") ?? undefined,
    before: params.get("before") ?? undefined,
    exclude: params.get("exclude") ?? undefined,
  });
}

/** The URL a filter link points at — also what the island pushes onto history. */
export function weekViewHref(view: WeekView): string {
  return view === "all" ? "/dashboard" : `/dashboard?view=${view}`;
}

/**
 * One page of weeks for a filter, newest first. Keyset pagination on window_start rather than
 * offset: the list grows by one week at a time, so a cursor on the last row's own window_start
 * never skips or repeats a week as new ones arrive.
 */
export async function loadWeekPage(
  client: ServiceClient,
  query: WeekPageQuery,
): Promise<{ ok: true; data: WeekPage } | { ok: false; message: string }> {
  const view = WEEK_VIEWS.find((v) => v.id === query.view) ?? WEEK_VIEWS[0];
  let request = client
    .from("digest")
    .select(WEEK_ROW_COLUMNS)
    .order("window_start", { ascending: false })
    // A week can hold several digests once earlier runs have ended; the newest leads.
    .order("created_at", { ascending: false })
    .limit(WEEK_PAGE_SIZE);
  if (view.statuses) request = request.in("status", view.statuses);
  if (query.before) request = request.lt("window_start", query.before);

  const { data, error } = await request;
  if (error) return { ok: false, message: `${error.code}: ${error.message}` };

  // The page is full-sized before the current week is filtered out, so "is there more" is decided
  // on the raw count, and the cursor on the raw last row.
  const nextBefore = data.length === WEEK_PAGE_SIZE ? (data.at(-1)?.window_start ?? null) : null;
  return { ok: true, data: { weeks: data.filter((week) => week.id !== query.exclude), nextBefore } };
}

/** One-line context under a row's week. */
export function weekRowNote(week: Pick<WeekRow, "status" | "last_error">): string {
  switch (week.status) {
    case "skipped":
    case "closed":
      return "Nothing was published";
    case "failed":
      return week.last_error ?? "Stopped without a diagnostic";
    case "rejected":
      return "Waiting for a rewrite";
    default:
      return "";
  }
}
