// S-07: the content approval gate's write endpoint (FR-020, US-16) — mirrors
// src/pages/api/selection/confirm.ts's shape exactly, the app's second domain API route.
//
// It does almost nothing itself on purpose: validation lives in @/lib/approval/rules (shared
// with the island so the two cannot disagree) and the write is one `record_approval` RPC, which
// performs the whole gate in a single transaction. What this file owns is the HTTP contract —
// authentication, JSON in, typed JSON out, and the mapping from the function's SQLSTATEs onto
// ApprovalErrorReason.
import type { APIRoute } from "astro";
import type { ZodError } from "zod";

import { approvalRequestSchema } from "@/lib/approval/rules";
import { createServiceClient } from "@/lib/supabase-admin";
import type { ApprovalErrorReason } from "@/types";

export const prerender = false;

/**
 * record_approval's raised SQLSTATEs, plus the unique violation a second decision produces.
 *
 * Mapping on `error.code` rather than message text is deliberate and verified: the Phase 1
 * integration suite for the S-04 gate already established that PostgREST passes custom
 * SQLSTATEs through unmodified, and record_approval follows the identical pattern.
 *
 * A Map rather than a Record so the lookup is honestly typed `| undefined`: an unrecognised
 * SQLSTATE is a real possibility (a future migration, or a constraint firing that this route does
 * not know about), and an index signature would type that miss away.
 */
const RPC_ERRORS = new Map<string, { reason: ApprovalErrorReason; status: number; message: string }>([
  ["AG001", { reason: "not_found", status: 404, message: "that digest no longer exists" }],
  ["AG002", { reason: "wrong_status", status: 409, message: "this digest is no longer awaiting approval" }],
  ["AG003", { reason: "invalid_request", status: 400, message: "note must be 2000 characters or fewer" }],
  ["23505", { reason: "already_decided", status: 409, message: "this digest has already been decided" }],
]);

function fail(status: number, reason: ApprovalErrorReason, message: string): Response {
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

  const parsed = approvalRequestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, "invalid_request", firstIssue(parsed.error));
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return fail(503, "not_configured", "Supabase is not configured");
  }

  const { digestId, decision, note } = parsed.data;

  const { data, error } = await supabase.rpc("record_approval", {
    p_digest_id: digestId,
    p_decision: decision,
    p_note: note ?? null,
  });

  if (error) {
    console.error(`record_approval failed for digest ${digestId}: ${error.code}: ${error.message}`);
    const mapped = RPC_ERRORS.get(error.code);
    // An unmapped code is a genuine surprise: report it as a server error and keep the raw
    // Postgres message out of the response, matching how the dashboard pages log-and-generalise.
    if (!mapped) return fail(500, "database_error", "could not record the decision");
    // The mapped branch is held to the same rule. record_approval's own AG0xx messages are
    // written for a human, but 23505 is Postgres's, and it names the table and constraint that
    // collided — the island renders this text verbatim, so the response carries our wording and
    // the console.error above keeps the database's.
    return fail(mapped.status, mapped.reason, mapped.message);
  }

  return Response.json({ ok: true, approvalId: data }, { status: 200 });
};
