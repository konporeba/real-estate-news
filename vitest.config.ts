import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // `astro:env/server` is an Astro build-pipeline virtual module; outside of it the
      // import is unresolvable, so tests get a process.env-backed shim instead.
      {
        find: "astro:env/server",
        replacement: fileURLToPath(new URL("./test/shims/astro-env-server.ts", import.meta.url)),
      },
      // Mirrors the `@/*` path alias in tsconfig.json. Anchored to `@/` so scoped npm
      // packages (`@supabase/...`) are left alone.
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
