// WORKER-SIDE ENTRYPOINT. `npm run worker:watch` — the background worker for a test session on the
// operator's own machine: it runs the advance job in a loop until stopped, so a started run, a
// confirmed pick, a retry or an edit moves on within seconds. It runs ONLY that job: no Sunday
// collection, no Monday reminder, no Tuesday publish. One process, one loop, so unlike scheduled-run
// it needs no job claim, and a Ctrl-C can never leave a claim blocking the next session; a week
// stopped mid-stage is simply picked up again by the next start.
//
// Runs in plain Node, never in the Astro/workerd runtime (eslint.config.js enforces it).
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { runAdvance } from "@/worker/advance";
import { loadWorkerEnv } from "@/worker/env";

const TICK_MS = 30_000;

/** One pass. Never throws: a database blip must not end a session. */
export async function tick(client: ServiceClient, advance: typeof runAdvance = runAdvance): Promise<void> {
  try {
    const result = await advance(client);
    if (!result.ok) console.error(`[watch] ${result.error ?? "a week failed"}`);
  } catch (error: unknown) {
    console.error(`[watch] this pass failed, trying again: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const client = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  // Printed first: a client-test email must not go to the wrong person or link to localhost.
  console.log(`[watch] emails go to ${env.OPERATOR_EMAIL ?? "nobody (OPERATOR_EMAIL is not set)"}`);
  console.log(`[watch] email links open ${env.DASHBOARD_BASE_URL ?? "nothing (DASHBOARD_BASE_URL is not set)"}`);
  console.log("[watch] running. Press Ctrl-C to stop.");

  for (;;) {
    await tick(client);
    await sleep(TICK_MS);
  }
}

// Only run when executed directly, so the tests can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
