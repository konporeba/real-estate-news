// SERVER-ONLY, ASTRO-SIDE. Supplies the service-role client to code running inside the
// Astro runtime, reading its credentials from astro:env/server. Never import it from a
// React island, any client-reachable path, or anything under src/worker/ — the worker runs
// in plain Node, where astro:env/server does not resolve, and uses src/worker/env.ts.
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "astro:env/server";

import { createServiceClient as buildServiceClient, type ServiceClient } from "@/lib/supabase-service";

/**
 * Privileged, server-only client for domain-table access (digest/article/cluster).
 * The service-role key bypasses RLS. Returns null when the key is absent (mirrors
 * src/lib/supabase.ts), so callers must handle the unconfigured case.
 */
export function createServiceClient(): ServiceClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return buildServiceClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}
