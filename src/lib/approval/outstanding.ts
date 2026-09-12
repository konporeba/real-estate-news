// SHARED between both runtimes, like everything else in src/lib/digest/: the worker's reminder
// job reads this to decide what to email, and it could equally be read from the app side later.
// Takes the client as a parameter and constructs nothing, so it resolves in the Astro runtime, in
// Vitest, and in the plain Node worker alike.
//
// FR-021/US-17: names which human gate a digest is waiting at, so the Monday reminder can say so.
// The two gates are `ready_for_selection` (S-04, US-09 not yet done) and `ready_for_approval`
// (S-07, US-16 not yet done) -- the only two states where the next move is a human decision, not
// a worker run.
import type { PostgrestError } from "@supabase/supabase-js";

import type { ServiceClient } from "@/lib/supabase-service";
import type { DigestRun, RunStateError, RunStateResult } from "@/types";

export type OutstandingGateKind = "selection" | "approval";

export interface OutstandingGate {
  digest: DigestRun;
  gate: OutstandingGateKind;
}

function databaseError(error: PostgrestError): RunStateError {
  return { ok: false, reason: "database_error", message: `${error.code}: ${error.message}` };
}

/**
 * Every digest currently waiting on the operator, oldest week first -- the longest-outstanding
 * gate is the one most worth naming first if more than one digest is stuck.
 */
export async function findOutstandingGates(client: ServiceClient): Promise<RunStateResult<OutstandingGate[]>> {
  const { data, error } = await client
    .from("digest")
    .select("*")
    .in("status", ["ready_for_selection", "ready_for_approval"])
    .order("window_start", { ascending: true });

  if (error) return databaseError(error);

  const gates = data.map(
    (digest): OutstandingGate => ({
      digest,
      gate: digest.status === "ready_for_selection" ? "selection" : "approval",
    }),
  );

  return { ok: true, data: gates };
}
