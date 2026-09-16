// S-08: the manual "Publish now" endpoint (FR-023, US-18) — mirrors
// src/pages/api/approval/decide.ts's shape: auth check before any body parsing, JSON in, typed
// JSON out. It does almost nothing itself on purpose: the actual work is one runPublish() call,
// the SAME orchestrator src/worker/publish.ts's scheduled/manual worker path calls, built here
// with app-sourced publisher clients (src/lib/publishing-admin.ts) instead of the worker's.
// Sharing the orchestrator is what guarantees a manual retrigger and the Tuesday scheduled fire
// can never disagree about which platforms already succeeded.
import type { APIRoute } from "astro";
import { z } from "zod";

import { buildPublishers } from "@/lib/publishing-admin";
import { runPublish } from "@/lib/publishing/run";
import { createServiceClient } from "@/lib/supabase-admin";
import type { PublicationErrorReason } from "@/types";

export const prerender = false;

const triggerRequestSchema = z.object({ digestId: z.uuid() });

/** Maps runPublish's own PublicationErrorReason onto an HTTP status, mirroring decide.ts's RPC_ERRORS map. */
const STATUS_BY_REASON: Record<PublicationErrorReason, number> = {
  unauthorized: 401,
  invalid_request: 400,
  wrong_status: 409,
  not_found: 404,
  not_configured: 503,
  database_error: 500,
};

function fail(reason: PublicationErrorReason, message: string): Response {
  return Response.json({ ok: false, reason, message }, { status: STATUS_BY_REASON[reason] });
}

export const POST: APIRoute = async (context) => {
  // Order is load-bearing, exactly as in decide.ts: the middleware's PROTECTED_ROUTES covers only
  // "/dashboard", so this path is not gated there, and the check happens before the body is read
  // so an unauthenticated caller never reaches the database.
  if (!context.locals.operatorAuthenticated) {
    return fail("unauthorized", "operator session required");
  }

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return fail("invalid_request", "request body must be JSON");
  }

  const parsed = triggerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_request", "digestId must be a valid uuid");
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return fail("not_configured", "Supabase is not configured");
  }

  const outcome = await runPublish(supabase, parsed.data.digestId, buildPublishers());

  if (!outcome.ok) {
    console.error(`runPublish failed for digest ${parsed.data.digestId}: ${outcome.reason}: ${outcome.message}`);
    return fail(outcome.reason, outcome.message);
  }

  return Response.json({ ok: true, summary: outcome.data }, { status: 200 });
};
