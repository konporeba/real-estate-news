// State for the WeekList island: the current filter, its weeks, and switching between filters
// without a page reload. The server renders the first page (so the list works, and is fast,
// without JavaScript); this hook takes over from there, fetching /api/digests and keeping the URL
// in step with history.pushState so reload, bookmarks and the back button still land on the
// filter the operator was looking at.
import { useCallback, useEffect, useRef, useState } from "react";

import { parseWeekPageQuery, weekViewHref, type WeekRow, type WeekView } from "@/lib/digest/week-list";

interface PageResponse {
  ok?: boolean;
  weeks?: WeekRow[];
  nextBefore?: string | null;
  message?: string;
}

export interface UseWeekList {
  view: WeekView;
  weeks: WeekRow[];
  nextBefore: string | null;
  /** A filter switch is in flight; the old rows stay on screen until it lands. */
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  selectView: (view: WeekView) => void;
  loadOlder: () => void;
  /** Reload the current filter's first page — after a week was retried, closed or deleted. */
  refresh: () => void;
}

export interface WeekListInitial {
  view: WeekView;
  weeks: WeekRow[];
  nextBefore: string | null;
  /** The "this week" card's digest, kept out of the list. */
  excludeId: string | null;
}

async function fetchPage(
  view: WeekView,
  before: string | null,
  excludeId: string | null,
  signal: AbortSignal,
): Promise<{ weeks: WeekRow[]; nextBefore: string | null }> {
  const params = new URLSearchParams({ view });
  if (before) params.set("before", before);
  if (excludeId) params.set("exclude", excludeId);

  const response = await fetch(`/api/digests?${params.toString()}`, { signal });
  const body = (await response.json().catch(() => ({}))) as PageResponse;
  if (!response.ok || !body.ok || !body.weeks) {
    throw new Error(body.message ?? "Couldn't load your weeks.");
  }
  return { weeks: body.weeks, nextBefore: body.nextBefore ?? null };
}

export function useWeekList(initial: WeekListInitial): UseWeekList {
  const [view, setView] = useState<WeekView>(initial.view);
  const [weeks, setWeeks] = useState<WeekRow[]>(initial.weeks);
  const [nextBefore, setNextBefore] = useState<string | null>(initial.nextBefore);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may write the list: a slow "All" landing after a quick "Needs me"
  // would otherwise show the wrong weeks under the selected filter.
  const inFlight = useRef<AbortController | null>(null);
  const olderInFlight = useRef<AbortController | null>(null);
  const { excludeId } = initial;

  const show = useCallback(
    async (next: WeekView, push: boolean) => {
      inFlight.current?.abort();
      // Older rows of the filter being left must not be appended to the new one.
      olderInFlight.current?.abort();
      setLoadingOlder(false);
      const controller = new AbortController();
      inFlight.current = controller;

      setView(next);
      setLoading(true);
      setError(null);
      if (push) window.history.pushState({ view: next }, "", weekViewHref(next));
      try {
        const page = await fetchPage(next, null, excludeId, controller.signal);
        setWeeks(page.weeks);
        setNextBefore(page.nextBefore);
      } catch (cause: unknown) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Couldn't load your weeks.");
      } finally {
        if (inFlight.current === controller) setLoading(false);
      }
    },
    [excludeId],
  );

  const selectView = useCallback(
    (next: WeekView) => {
      void show(next, true);
    },
    [show],
  );

  const refresh = useCallback(() => {
    void show(view, false);
  }, [show, view]);

  const loadOlder = useCallback(() => {
    if (!nextBefore || loading || loadingOlder) return;
    const controller = new AbortController();
    olderInFlight.current = controller;
    setLoadingOlder(true);
    setError(null);
    fetchPage(view, nextBefore, excludeId, controller.signal)
      .then((page) => {
        setWeeks((current) => [...current, ...page.weeks]);
        setNextBefore(page.nextBefore);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Couldn't load older weeks.");
      })
      .finally(() => {
        if (olderInFlight.current === controller) setLoadingOlder(false);
      });
  }, [view, nextBefore, excludeId, loading, loadingOlder]);

  // Back/forward between filters: the URL already changed, so read the filter from it.
  useEffect(() => {
    const onPopState = () => {
      void show(parseWeekPageQuery(new URLSearchParams(window.location.search)).view, false);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [show]);

  return { view, weeks, nextBefore, loading, loadingOlder, error, selectView, loadOlder, refresh };
}
