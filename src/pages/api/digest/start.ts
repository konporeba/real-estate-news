// "Start a new run": test mode only. In production the Sunday job starts each run, so this refuses
// whenever real posting is enabled. The week logic lives in @/lib/digest/start-run.
import type { APIRoute } from "astro";

import { startRun } from "@/lib/digest/start-run";
import { isPublishingEnabled } from "@/lib/publishing-admin";
import { createServiceClient } from "@/lib/supabase-admin";

export const prerender = false;

function fail(status: number, reason: string, message: string): Response {
  return Response.json({ ok: false, reason, message }, { status });
}

export const POST: APIRoute = async (context) => {
  if (!context.locals.operatorAuthenticated) return fail(401, "unauthorized", "operator session required");
  if (isPublishingEnabled()) return fail(403, "not_allowed", "Runs start on their own schedule outside test mode.");

  const client = createServiceClient();
  if (!client) return fail(503, "not_configured", "Supabase is not configured");

  const result = await startRun(client);
  if (!result.ok) {
    if (result.reason === "database_error") {
      console.error(`start run failed: ${result.message}`);
      return fail(500, result.reason, "Something went wrong starting the run. Please try again.");
    }
    return fail(409, result.reason, result.message);
  }
  return Response.json({ ok: true, digestId: result.digestId });
};
