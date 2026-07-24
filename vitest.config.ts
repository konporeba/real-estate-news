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
    // Test FILES run one at a time. The integration suites share one global resource —
    // the `digest` table — and some of their assertions are about its global state
    // ("nothing is recoverable", "the newest recoverable digest is X"). Run in parallel,
    // one suite's rows change another's answer: this was observed failing roughly one run
    // in three before being serialised. Picking unused weeks per suite is not enough,
    // because "newest anywhere" is not scoped to a week.
    fileParallelism: false,
    // Supabase credentials live in `.env` (git-ignored). Integration suites skip
    // themselves when these are unset. COLLECTION_LIVE_SMOKE gates the live RSS suite.
    env: loadEnv("test", process.cwd(), ["SUPABASE_", "COLLECTION_"]),
  },
});
