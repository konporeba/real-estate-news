// S-04: the story selection gate's write endpoint (FR-012, US-09, US-10) — the app's first
// domain API route.
//
// It does almost nothing itself on purpose: validation lives in @/lib/selection/rules (shared
// with the island so the two cannot disagree) and the write is one `confirm_selection` RPC, which
// performs the whole gate in a single transaction. What this file owns is the HTTP contract —
// authentication, JSON in, typed JSON out, and the mapping from the function's SQLSTATEs onto
// SelectionErrorReason.
import type { APIRoute } from "astro";
import type { ZodError } from "zod";

import { selectionRequestSchema } from "@/lib/selection/rules";
import { createServiceClient } from "@/lib/supabase-admin";
import type { SelectionErrorReason } from "@/types";

export const prerender = false;

/**
 * confirm_selection's raised SQLSTATEs, plus the unique violation a second confirm produces.
 *
 * Mapping on `error.code` rather than message text is deliberate and verified: the Phase 1
 * integration suite asserts PostgREST passes these custom SQLSTATEs through unmodified.
 *
 * SG005 is a 409 rather than a 400: the request was well-formed, but the shortlist it carries no
 * longer matches the digest's ranked clusters — a stale page, not a malformed client.
 *
 * A Map rather than a Record so the lookup is honestly typed `| undefined`: an unrecognised
 * SQLSTATE is a real possibility (a future migration, or a constraint firing that this route does
 * not know about), and an index signature would type that miss away.
 */
const RPC_ERRORS = new Map<string, { reason: SelectionErrorReason; status: number }>([
  ["SG001", { reason: "not_found", status: 404 }],
  ["SG002", { reason: "wrong_status", status: 409 }],
  ["SG003", { reason: "invalid_request", status: 400 }],
  ["SG004", { reason: "invalid_request", status: 400 }],
  ["SG005", { reason: "stale_shortlist", status: 409 }],
  ["23505", { reason: "already_confirmed", status: 409 }],
]);

function fail(status: number, reason: SelectionErrorReason, message: string): Response {
  return Response.json({ ok: false, reason, message }, { status });
}

/** The most specific complaint the schema produced — the island renders this verbatim. */
function firstIssue(error: ZodError): string {
  // .at() rather than [0]: the array is typed non-empty, but a zero-issue ZodError is not
  // structurally impossible and an out-of-range index would be `undefined` at runtime.
  const issue = error.issues.at(0);
  if (!issue) return "the request could not be validated";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export const POST: APIRoute = async (context) => {
  // Order is load-bearing. The middleware's PROTECTED_ROUTES covers only "/dashboard", so this
  // path is not gated there — and it must not simply be added, because the middleware answers
  // with a 302 to /auth/pin, which a fetch() caller would follow and then fail to parse as JSON.
  // The check happens before the body is read, so an unauthenticated caller never reaches the
  // validator or the database.
  if (!context.locals.operatorAuthenticated) {
    return fail(401, "unauthorized", "operator session required");
  }

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return fail(400, "invalid_request", "request body must be JSON");
  }

  const parsed = selectionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, "invalid_request", firstIssue(parsed.error));
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return fail(503, "not_configured", "Supabase is not configured");
  }

  const { digestId, shortlistClusterIds, pickedClusterIds, format, platforms } = parsed.data;

  const { data, error } = await supabase.rpc("confirm_selection", {
    p_digest_id: digestId,
    p_shortlist_cluster_ids: shortlistClusterIds,
    p_picked_cluster_ids: pickedClusterIds,
    p_format: format,
    p_platforms: platforms,
  });

  if (error) {
    console.error(`confirm_selection failed for digest ${digestId}: ${error.code}: ${error.message}`);
    const mapped = RPC_ERRORS.get(error.code);
    // An unmapped code is a genuine surprise: report it as a server error and keep the raw
    // Postgres message out of the response, matching how the dashboard pages log-and-generalise.
    if (!mapped) return fail(500, "database_error", "could not confirm the selection");
    return fail(mapped.status, mapped.reason, error.message);
  }

  return Response.json({ ok: true, selectionId: data }, { status: 200 });
};
