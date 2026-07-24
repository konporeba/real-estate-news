import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // Mirrors the `@/*` path alias in tsconfig.json. Anchored to `@/` so scoped npm
      // packages (`@supabase/...`) are left alone.
      //
      // No `astro:env/server` shim is needed: modules under test take their Supabase
      // client as a parameter rather than reading Astro's virtual env module. If a suite
      // ever imports Astro-side code directly it will need one again.
      { find: /^@\//, replacement: fileURLToPath(new URL("./src/", import.meta.url)) },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests round-trip to the configured Supabase project; the default 5s
    // is tight for a remote database.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Supabase credentials live in `.env` (git-ignored). Integration suites skip
    // themselves when these are unset.
    env: loadEnv("test", process.cwd(), "SUPABASE_"),
  },
});
