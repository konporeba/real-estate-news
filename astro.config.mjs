// @ts-check
import { defineConfig, envField } from "astro/config";

import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  output: "server",
  integrations: [react(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  adapter: cloudflare(),
  env: {
    schema: {
      SUPABASE_URL: envField.string({ context: "server", access: "secret", optional: true }),
      SUPABASE_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      SUPABASE_SERVICE_ROLE_KEY: envField.string({
        context: "server",
        access: "secret",
        optional: true,
      }),
      PIN_HASH: envField.string({ context: "server", access: "secret", optional: true }),
      PIN_PEPPER: envField.string({ context: "server", access: "secret", optional: true }),
      SESSION_SECRET: envField.string({ context: "server", access: "secret", optional: true }),
      // S-08: manual "Publish now" from the dashboard needs the same platform credentials the
      // worker's scheduled publish uses — see src/lib/publishing-admin.ts and .env.example.
      META_ACCESS_TOKEN: envField.string({ context: "server", access: "secret", optional: true }),
      META_PAGE_ID: envField.string({ context: "server", access: "secret", optional: true }),
      META_IG_USER_ID: envField.string({ context: "server", access: "secret", optional: true }),
      LINKEDIN_ACCESS_TOKEN: envField.string({ context: "server", access: "secret", optional: true }),
      LINKEDIN_ORGANIZATION_URN: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
});
