// Starts a run on demand: creates the current week's digest in `collecting`, and the worker's
// advance job does the rest. Test mode only — in production the Sunday job starts each run. Shared
// code: takes its client as a parameter, and works out the week itself because the app may not
// import src/lib/collection/ (a test holds this to currentWeekWindow).
import { createDigest } from "@/lib/digest/run-state";
import type { ServiceClient } from "@/lib/supabase-service";
import type { DigestWindow } from "@/types";

const WARSAW_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The Monday–Sunday week containing `instant`, on the Warsaw calendar. */
export function weekContaining(instant: Date): DigestWindow {
  const today = WARSAW_DATE.format(instant);
  const daysSinceMonday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(today, -daysSinceMonday);
  return { start, end: addDays(start, 6) };
}

export type StartRunResult =
  | { ok: true; digestId: string }
  | { ok: false; reason: "already_running" | "database_error"; message: string };

export async function startRun(client: ServiceClient, now: Date = new Date()): Promise<StartRunResult> {
  const created = await createDigest(client, weekContaining(now));
  if (created.ok) return { ok: true, digestId: created.data.id };
  return created.reason === "active_digest_exists"
    ? {
        ok: false,
        reason: "already_running",
        message: "This week already has an open run. Finish it, or close or delete it, then start a new one.",
      }
    : { ok: false, reason: "database_error", message: created.message };
}
