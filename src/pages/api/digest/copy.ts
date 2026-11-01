// The approval page's text editor: saves the operator's edits to each story's title and caption
// and sends the week back to `rendering` so the Pi redraws the slides. The rules (what may be
// edited, the slide-fit check, the order of writes) live in @/lib/digest/edit-copy.
import type { APIRoute } from "astro";

import { copyEditRequestSchema } from "@/lib/digest/copy-rules";
import { saveCopyEdits } from "@/lib/digest/edit-copy";
import { createServiceClient } from "@/lib/supabase-admin";

export const prerender = false;

const STATUS_FOR = { not_found: 404, not_allowed: 409, invalid_copy: 400, database_error: 500 } as const;

function fail(status: number, reason: string, message: string): Response {
  return Response.json({ ok: false, reason, message }, { status });
}

export const POST: APIRoute = async (context) => {
  // Checked before the body is read; not under PROTECTED_ROUTES for the same reason as
  // /api/selection/confirm (a redirect would break the fetch() caller).
  if (!context.locals.operatorAuthenticated) return fail(401, "unauthorized", "operator session required");

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return fail(400, "invalid_request", "request body must be JSON");
  }
  const parsed = copyEditRequestSchema.safeParse(body);
  if (!parsed.success)
    return fail(400, "invalid_request", "expected a digestId and 1-4 stories with a title and caption");

  const client = createServiceClient();
  if (!client) return fail(503, "not_configured", "Supabase is not configured");

  const result = await saveCopyEdits(client, parsed.data.digestId, parsed.data.stories);
  if (!result.ok) {
    if (result.reason === "database_error") console.error(`copy edit failed: ${result.message}`);
    return Response.json(result, { status: STATUS_FOR[result.reason] });
  }
  return Response.json({ ok: true });
};
