// Test-only stand-in for Astro's `astro:env/server` virtual module, which only exists
// inside Astro's build pipeline and cannot be resolved by Vitest. `vitest.config.ts`
// aliases the virtual module here; the values come from process.env, populated from
// `.env` by that same config.
//
// Keep the exported names in sync with the `env.schema` block in `astro.config.mjs`.
// All fields are declared `optional: true` there, hence `string | undefined` here.
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
