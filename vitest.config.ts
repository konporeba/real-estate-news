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
    // is tight for a remote database. Raised from 20s to 40s when S-06 added the rendering
    // suite: at ~700ms per round trip a case that seeds a digest (nine trips) and then runs a
    // stage (seven more) sits close enough to 20s that a slow minute on the remote project
    // failed a different two or three cases on every run, always with "Test timed out" and
    // never with an assertion. The tests are latency-bound, not slow.
    testTimeout: 40_000,
    hookTimeout: 40_000,
    // Test FILES run one at a time. The integration suites share one global resource —
    // the `digest` table — and some of their assertions are about its global state
    // ("nothing is recoverable", "the newest recoverable digest is X"). Run in parallel,
    // one suite's rows change another's answer: this was observed failing roughly one run
    // in three before being serialised. Picking unused weeks per suite is not enough,
    // because "newest anywhere" is not scoped to a week.
    fileParallelism: false,
    // Supabase credentials live in `.env` (git-ignored). Integration suites skip
    // themselves when these are unset. COLLECTION_LIVE_SMOKE gates the live RSS suite.
    // GMAIL_/OPERATOR_ gate the F-04 email live smoke suite (EMAIL_LIVE_SMOKE).
    // GOOGLE_/SLIDES_ gate the S-06 Slides live smoke suite (SLIDES_LIVE_SMOKE) — without the
    // prefix here the credentials sit in .env unread and the suite silently skips itself.
    // HEARTBEAT_ gates the S-10 heartbeat live smoke suite (HEARTBEAT_LIVE_SMOKE), same reason.
    env: loadEnv("test", process.cwd(), [
      "SUPABASE_",
      "COLLECTION_",
      "GMAIL_",
      "OPERATOR_",
      "GOOGLE_",
      "SLIDES_",
      "HEARTBEAT_",
    ]),
  },
});
