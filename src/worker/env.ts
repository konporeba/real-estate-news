// WORKER-SIDE. Environment access for the plain Node pipeline process.
//
// Nothing under src/worker/ may import astro:env/server (or src/lib/supabase-admin.ts,
// which does): that virtual module exists only inside Astro's build and fails to resolve
// in Node. This module is the worker's equivalent — values come from process.env, loaded
// from .env by Node's --env-file flag.
import { z } from "zod";

const workerEnvSchema = z.object({
  SUPABASE_URL: z.url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY must not be empty"),
  // F-03: the LLM harness's credentials and spend ceiling.
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY must not be empty"),
  // Hard per-digest USD ceiling. `coerce` because process.env values are strings; the default
  // keeps the worker runnable before the operator tunes it. Tightening this needs no deploy.
  LLM_COST_CEILING_USD: z.coerce.number().positive("LLM_COST_CEILING_USD must be a positive number").default(5),
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
