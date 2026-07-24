// SERVER-ONLY. This module constructs a Supabase client with the service-role key,
// which bypasses row-level security entirely. Never import it from a React island or
// any client-reachable path. Reads secrets from astro:env/server.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "astro:env/server";

import type { Database } from "@/db/database.types";

/**
 * Privileged, server-only client for domain-table access (digest/article/cluster).
 * The service-role key bypasses RLS, so every server-side read/write of the domain
 * tables goes through here. Returns null when the key is absent (mirrors
 * src/lib/supabase.ts), so callers must handle the unconfigured case.
 */
export function createServiceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
