// WORKER-SIDE. Environment access for the plain Node pipeline process.
//
// Nothing under src/worker/ may import astro:env/server (or src/lib/supabase-admin.ts,
// which does): that virtual module exists only inside Astro's build and fails to resolve
// in Node. This module is the worker's equivalent — values come from process.env, loaded
// from .env by Node's --env-file flag.
import { z } from "zod";

import { ASSET_BUCKET } from "@/lib/digest/assets";

const workerEnvSchema = z.object({
  SUPABASE_URL: z.url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY must not be empty"),
  // F-03: the LLM harness's credentials and spend ceiling.
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY must not be empty"),
  // Hard per-digest USD ceiling. `coerce` because process.env values are strings; the default
  // keeps the worker runnable before the operator tunes it. Tightening this needs no deploy.
  LLM_COST_CEILING_USD: z.coerce.number().positive("LLM_COST_CEILING_USD must be a positive number").default(5),
  // F-04: the email harness's Gmail SMTP credentials and the fixed single-operator recipient.
  // All three are optional — no pipeline stage calls the harness yet, so an unconfigured worker
  // must keep running. createEmailClient() returns null when these are absent.
  GMAIL_USER: z.email("GMAIL_USER must be a valid email address").optional(),
  GMAIL_APP_PASSWORD: z.string().min(1, "GMAIL_APP_PASSWORD must not be empty").optional(),
  OPERATOR_EMAIL: z.email("OPERATOR_EMAIL must be a valid email address").optional(),
  // S-04/FR-010: where the dashboard is reachable, for the digest-ready email's link. The worker
  // has no other way to know — it never serves the app. Optional like the Gmail credentials: an
  // unset value sends the notification without a button rather than one pointing nowhere.
  DASHBOARD_BASE_URL: z.url("DASHBOARD_BASE_URL must be a valid URL").optional(),
  // S-06/FR-015: the Google Slides rendering stage. All optional, like the Gmail block — a worker
  // with no Slides config still collects, ranks and generates; only `npm run visuals` needs these,
  // and createSlidesClient() returns null without them so the stage reports `not_configured`
  // rather than dying on an auth error mid-run.
  //
  // The private key is BASE64-ENCODED, not raw PEM. A service-account key contains literal
  // newlines, and this project has already lost time to dotenv mangling a secret (F-02's
  // PIN_PEPPER, silently truncated at a `#`). Base64 has no character dotenv treats specially, so
  // it survives both .env and .dev.vars parsing unchanged. Encode with:
  //   base64 -w0 service-account.json | ...   (or see .env.example)
  GOOGLE_SA_EMAIL: z.email("GOOGLE_SA_EMAIL must be a valid email address").optional(),
  GOOGLE_SA_PRIVATE_KEY_B64: z.string().min(1, "GOOGLE_SA_PRIVATE_KEY_B64 must not be empty").optional(),
  // Presentation ids of the operator's two template decks, taken from the Slides URL:
  // docs.google.com/presentation/d/<THIS PART>/edit
  SLIDES_DECK_SINGLE_POST: z.string().min(1, "SLIDES_DECK_SINGLE_POST must not be empty").optional(),
  SLIDES_DECK_CAROUSEL: z.string().min(1, "SLIDES_DECK_CAROUSEL must not be empty").optional(),
  // Where rendered PNGs are stored. Defaulted rather than optional: the bucket is created by
  // migration 20260908140000, so the name is a deployment detail, not a missing capability. The
  // default comes from the shared constant the dashboard signs URLs against, so the two cannot
  // drift into pointing at different buckets.
  SUPABASE_ASSET_BUCKET: z.string().min(1).default(ASSET_BUCKET),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Reads and validates the worker's environment, throwing a message that names what is
 * missing. Failing loudly at startup beats a null client surfacing as a confusing error
 * several stages into an unattended weekly run.
 */
export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Worker environment is not configured.\n${problems}\n\nSet these in .env (see .env.example).`);
  }
  return parsed.data;
}
