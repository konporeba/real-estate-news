// The dashboard's week actions — retry, close, delete — as one write endpoint. The rules live in
// @/lib/digest/week-actions (which actions a week allows, where a retry restarts it) and the
// database work in @/lib/digest/manage-week; this file owns the HTTP contract.
import type { APIRoute } from "astro";

import { applyWeekAction, type ManageWeekErrorReason } from "@/lib/digest/manage-week";
import { weekActionRequestSchema } from "@/lib/digest/week-actions";
import { createServiceClient } from "@/lib/supabase-admin";

export const prerender = false;

const STATUS_FOR: Record<ManageWeekErrorReason, number> = {
  not_found: 404,
  not_allowed: 409,
  database_error: 500,
};

function fail(status: number, reason: string, message: string): Response {
  return Response.json({ ok: false, reason, message }, { status });
}

export const POST: APIRoute = async (context) => {
  // Not under the middleware's PROTECTED_ROUTES (a redirect would break the fetch() caller), so
  // checked here, before the body is read — the same contract as /api/selection/confirm.
  if (!context.locals.operatorAuthenticated) return fail(401, "unauthorized", "operator session required");

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return fail(400, "invalid_request", "request body must be JSON");
  }
  const parsed = weekActionRequestSchema.safeParse(body);
  if (!parsed.success)
    return fail(400, "invalid_request", "expected a digestId and an action (retry, close or delete)");

  const client = createServiceClient();
  if (!client) return fail(503, "not_configured", "Supabase is not configured");

  const result = await applyWeekAction(client, parsed.data.digestId, parsed.data.action);
  if (!result.ok) {
    if (result.reason === "database_error") console.error(`week ${parsed.data.action} failed: ${result.message}`);
    return fail(
      STATUS_FOR[result.reason],
      result.reason,
      result.reason === "database_error" ? "Something went wrong saving that. Please try again." : result.message,
    );
  }
  if (result.warning) console.error(result.warning);
  return Response.json({ ok: true, week: result.week, warning: result.warning });
};
