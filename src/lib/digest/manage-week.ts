// Carries out a dashboard week action — retry, close, delete — against the database and the slide
// image bucket. Shared code like the rest of src/lib/digest/: it takes its client as a parameter.
// Every action re-reads the week and re-checks availableActions first, so the decision is made on
// the row as it is now, not as the operator's page last saw it.
import { ASSET_BUCKET } from "@/lib/digest/assets";
import { transitionDigest } from "@/lib/digest/run-state";
import { availableActions, isRunningNow, retryTarget, type WeekAction } from "@/lib/digest/week-actions";
import { WEEK_ROW_COLUMNS, type WeekRow } from "@/lib/digest/week-list";
import type { ServiceClient } from "@/lib/supabase-service";
import type { DigestStatus } from "@/types";

export type ManageWeekErrorReason = "not_found" | "not_allowed" | "database_error";

export type ManageWeekResult =
  | {
      ok: true;
      /** The week after the action; null once deleted. */
      week: WeekRow | null;
      /** Something that went wrong without undoing the action (orphaned slide files). */
      warning?: string;
    }
  | { ok: false; reason: ManageWeekErrorReason; message: string };

const ACTION_VERB: Record<WeekAction, string> = { retry: "retried", close: "closed", delete: "deleted" };

function failure(reason: ManageWeekErrorReason, message: string): ManageWeekResult {
  return { ok: false, reason, message };
}

export async function applyWeekAction(
  client: ServiceClient,
  digestId: string,
  action: WeekAction,
  now: Date = new Date(),
): Promise<ManageWeekResult> {
  const { data: week, error } = await client
    .from("digest")
    .select(`${WEEK_ROW_COLUMNS}, generation_completed_at`)
    .eq("id", digestId)
    .maybeSingle();
  if (error) return failure("database_error", `${error.code}: ${error.message}`);
  if (!week) return failure("not_found", "That week no longer exists.");

  if (!availableActions(week, now).includes(action)) {
    return failure(
      "not_allowed",
      isRunningNow(week, now)
        ? "This week is being worked on right now. Try again once this step finishes."
        : `This week can't be ${ACTION_VERB[action]} in its current state.`,
    );
  }

  switch (action) {
    case "delete":
      return deleteWeek(client, week);
    case "close":
      // Keep a failed week's diagnostic: it is the record of why the week ended.
      return transitionTo(client, week.id, "closed", week.last_error);
    case "retry":
      return retryWeek(client, week);
  }
}

async function transitionTo(
  client: ServiceClient,
  id: string,
  to: DigestStatus,
  lastError?: string | null,
): Promise<ManageWeekResult> {
  const moved = await transitionDigest(client, id, to, lastError === undefined ? {} : { lastError });
  if (!moved.ok) {
    return moved.reason === "illegal_transition" || moved.reason === "concurrent_modification"
      ? failure("not_allowed", "This week changed while you were looking at it. Reload the page and try again.")
      : failure("database_error", moved.message);
  }
  const { data } = moved;
  return {
    ok: true,
    week: {
      id: data.id,
      window_start: data.window_start,
      window_end: data.window_end,
      status: data.status,
      last_error: data.last_error,
      updated_at: data.updated_at,
    },
  };
}

async function retryWeek(
  client: ServiceClient,
  week: WeekRow & { generation_completed_at: string | null },
): Promise<ManageWeekResult> {
  const [selection, approval] = await Promise.all([
    client.from("selection").select("id").eq("digest_id", week.id).maybeSingle(),
    client.from("approval").select("decision, decided_at").eq("digest_id", week.id).maybeSingle(),
  ]);
  if (selection.error) return failure("database_error", selection.error.message);
  if (approval.error) return failure("database_error", approval.error.message);

  const target = retryTarget({
    status: week.status,
    generation_completed_at: week.generation_completed_at,
    hasSelection: selection.data !== null,
    rejectedAt: approval.data?.decision === "rejected" ? approval.data.decided_at : null,
  });
  if (!target) return failure("not_allowed", "This week can't be retried in its current state.");
  // Leaving `failed` clears last_error (transitionDigest): the retry starts a clean slate.
  return transitionTo(client, week.id, target);
}

/**
 * The row goes first (every child table cascades from it), the slide images second. A failure
 * removing images leaves files nobody can reach — worth a warning, not worth refusing a delete the
 * operator asked for, and not something to do before the row is safely gone.
 */
async function deleteWeek(client: ServiceClient, week: WeekRow): Promise<ManageWeekResult> {
  // Scoped to the status just checked: if a worker moved the week in between, nothing is deleted.
  const { data: deleted, error } = await client
    .from("digest")
    .delete()
    .eq("id", week.id)
    .eq("status", week.status)
    .select("id");
  if (error) return failure("database_error", `${error.code}: ${error.message}`);
  if (deleted.length === 0) {
    return failure("not_allowed", "This week changed while you were looking at it. Reload the page and try again.");
  }

  const bucket = client.storage.from(ASSET_BUCKET);
  // Listed rather than taken from generated_asset: a re-render with fewer slides leaves files no
  // row points at any more, and those belong to the week too.
  const { data: files, error: listError } = await bucket.list(week.id, { limit: 1000 });
  if (listError) {
    return {
      ok: true,
      week: null,
      warning: `The week is deleted, but its slide images could not be listed: ${listError.message}`,
    };
  }
  if (files.length > 0) {
    const { error: removeError } = await bucket.remove(files.map((file) => `${week.id}/${file.name}`));
    if (removeError) {
      return {
        ok: true,
        week: null,
        warning: `The week is deleted, but its slide images could not be removed: ${removeError.message}`,
      };
    }
  }
  return { ok: true, week: null };
}
