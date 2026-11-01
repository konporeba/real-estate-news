// The week list's read endpoint: one page of weeks for a filter, as JSON, so the dashboard's list
// island switches filters without reloading the page. The query and its fallbacks live in
// @/lib/digest/week-list, shared with the server-rendered first page.
import type { APIRoute } from "astro";

import { loadWeekPage, parseWeekPageQuery } from "@/lib/digest/week-list";
import { createServiceClient } from "@/lib/supabase-admin";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  // Not under the middleware's PROTECTED_ROUTES, whose answer is a redirect to the PIN page that a
  // fetch() would follow and then fail to parse — the same reasoning as /api/selection/confirm.
  if (!context.locals.operatorAuthenticated) {
    return Response.json({ ok: false, reason: "unauthorized", message: "operator session required" }, { status: 401 });
  }

  const client = createServiceClient();
  if (!client) {
    return Response.json(
      { ok: false, reason: "not_configured", message: "Supabase is not configured" },
      { status: 503 },
    );
  }

  const result = await loadWeekPage(client, parseWeekPageQuery(context.url.searchParams));
  if (!result.ok) {
    console.error(`failed to load weeks: ${result.message}`);
    return Response.json(
      { ok: false, reason: "database_error", message: "Couldn't load your weeks." },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, ...result.data });
};
