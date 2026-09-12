// WORKER-SIDE ENTRYPOINT. `npm run remind` — run the FR-021 Monday reminder once, on demand, so
// it can be verified without waiting for a Monday. src/worker/scheduled-run.ts's
// "approval-reminder" job calls this file's main() the same way its "collection" job calls
// collect.ts's and rank.ts's — the entrypoint owns the real logic, the scheduled job is a thin
// due-check wrapper around it.
//
// Unlike collect/rank/generate/visuals, this stage never transitions a digest and is idempotent
// by construction: running it twice in the same outstanding state just sends the reminder twice,
// which is why the scheduler's own due-check (not this file) is what prevents a real Monday from
// re-firing it.
//
// Runs in plain Node, never in the Astro/workerd runtime. Nothing here may import
// astro:env/server or src/lib/supabase-admin; eslint.config.js enforces both directions of that
// boundary.
import { pathToFileURL } from "node:url";

import { findOutstandingGates } from "@/lib/approval/outstanding";
import { createEmailClient } from "@/lib/email/client";
import { buildReminderEmail } from "@/lib/email/reminder";
import { sendEmail } from "@/lib/email/send";
import { createServiceClient } from "@/lib/supabase-service";
import { loadWorkerEnv } from "@/worker/env";

export async function main(): Promise<number> {
  const env = loadWorkerEnv();
  const client = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const outstanding = await findOutstandingGates(client);
  if (!outstanding.ok) {
    console.error(`could not read outstanding gates: ${outstanding.reason}: ${outstanding.message}`);
    return 1;
  }

  if (outstanding.data.length === 0) {
    console.log("nothing outstanding -- no reminder sent");
    return 0;
  }

  console.log(`${String(outstanding.data.length)} digest(s) outstanding:`);
  for (const gate of outstanding.data) {
    console.log(`  [${gate.gate}]  ${gate.digest.window_start} -> ${gate.digest.window_end}  (${gate.digest.id})`);
  }

  const transport = createEmailClient(
    env.GMAIL_USER && env.GMAIL_APP_PASSWORD ? { user: env.GMAIL_USER, appPassword: env.GMAIL_APP_PASSWORD } : null,
  );
  const request = buildReminderEmail(outstanding.data, env.DASHBOARD_BASE_URL);
  const result = await sendEmail(transport, env.OPERATOR_EMAIL, request);

  if (result.ok) {
    console.log(`reminder sent to ${env.OPERATOR_EMAIL ?? "?"}`);
    return 0;
  }
  if (result.reason === "not_configured") {
    console.log("reminder not sent: email is not configured (GMAIL_USER/GMAIL_APP_PASSWORD/OPERATOR_EMAIL)");
    return 0;
  }
  console.error(`reminder failed: ${result.reason}: ${result.message}`);
  return 1;
}

// Only run when executed directly, so the tests (and scheduled-run.ts) can import main() above.
// pathToFileURL rather than string concatenation: Windows paths (X:\...) do not form a
// valid file:// URL by prefixing, and this project is developed on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
