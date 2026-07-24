# Rules for AI

This file provides guidance to AI Agent when working with code in this repository.

## Commands

- `npm run dev` — start dev server (Cloudflare workerd runtime)
- `npm run build` — production build (SSR via `@astrojs/cloudflare`)
- `npm run preview` — preview production build
- `npm test` — Vitest (`vitest run`); integration suites write to the Supabase project in `.env` with RLS bypassed and run only when `SUPABASE_TEST_PROJECT=1` is set alongside `SUPABASE_SERVICE_ROLE_KEY` — otherwise they skip. Test files run serially (`fileParallelism: false`): the integration suites share the `digest` table and some assert on its global state.
- `npm run collect` — run the weekly source collection worker (plain Node via `tsx`). Targets, in order: `--week=YYYY-MM-DD` if given, else the newest recoverable digest (non-terminal or `failed`), else a new digest for the current Monday–Sunday. Exits 2 when it refuses a digest already past collection.
- `COLLECTION_LIVE_SMOKE=1 npx vitest run src/lib/collection/adapters/rss.live.test.ts` — fetch every enabled RSS source for real. Opt-in; catches a source changing its feed format or starting to block us, which fixtures cannot.
- `npm run lint` — ESLint with type-checked rules
- `npm run lint:fix` — auto-fix lint issues
- `npm run format` — Prettier (includes prettier-plugin-astro + prettier-plugin-tailwindcss)

Pre-commit hooks: husky + lint-staged runs `eslint --fix` on `*.{ts,tsx,astro}` and `prettier --write` on `*.{json,css,md}`.

## Two runtimes — do not cross the boundary

This repo builds for **two** runtimes, and an import crossing between them breaks a build.

- **Astro app** → Cloudflare workerd. `src/pages/`, `src/components/`, `src/layouts/`, `src/middleware.ts`.
- **Pipeline worker** → plain Node, launched by `npm run collect`. `src/worker/`, `src/lib/collection/`. Uses Node-oriented dependencies (`rss-parser`) and long-running work the edge runtime is wrong for.

Rules, enforced by `no-restricted-imports` in `eslint.config.js` (both directions):

- App code must **not** import `@/lib/collection/*` or `@/worker/*` — it drags Node built-ins into the workerd bundle. If a page needs collection results, read them from the database.
- Worker code must **not** import `astro:env/server`, `@/lib/supabase-admin`, or `@/lib/supabase` — `astro:env/server` is an Astro build-time virtual module that does not resolve in Node. Worker config comes from `src/worker/env.ts`; build the privileged client with `createServiceClient()` from `@/lib/supabase-service`.
- Shared code (`src/lib/digest/`, `src/lib/supabase-service.ts`) takes its Supabase client as a **parameter** rather than constructing one, which is what lets both runtimes use it.

## Architecture

**Astro 6 SSR app** with React 19 islands, Tailwind 4, Supabase auth, and shadcn/ui components. Deployed to Cloudflare Workers.

### Rendering mode

Full server-side rendering (`output: "server"` in astro.config.mjs). All pages are server-rendered by default. API routes must export `const prerender = false`.

### Auth flow

- `src/lib/supabase.ts` — creates a Supabase SSR client using `@supabase/ssr` with cookie-based sessions. Uses `astro:env/server` for `SUPABASE_URL` and `SUPABASE_KEY` (server-only secrets declared in astro.config.mjs `env.schema`).
- `src/middleware.ts` — runs on every request, resolves the current user, attaches to `context.locals.user`. Redirects unauthenticated users away from routes listed in `PROTECTED_ROUTES`.
- API endpoints: `src/pages/api/auth/{signin,signup,signout}.ts`
- Auth pages: `src/pages/auth/{signin,signup,confirm-email}.astro`
- Protected page example: `src/pages/dashboard.astro`

### Key conventions

- **Path alias**: `@/*` maps to `./src/*` (tsconfig paths).
- **Astro components** for static content/layout; **React components** only when interactivity is needed.
- **Tailwind class merging**: use the `cn()` helper from `@/lib/utils` (clsx + tailwind-merge) for conditional/merged class names. Do not concatenate class strings manually.
- **shadcn/ui**: components live in `src/components/ui/`, "new-york" style variant. Install new ones with `npx shadcn@latest add [name]`.
- **API routes**: use uppercase `GET`, `POST` exports; validate input with zod.
- **Supabase migrations**: `supabase/migrations/` using naming format `YYYYMMDDHHmmss_short_description.sql`. Always enable RLS on new tables with granular per-operation, per-role policies.
- **React**: no Next.js directives ("use client" etc.). Extract hooks to `src/components/hooks/`.
- **Services/helpers** go in `src/lib/` (or `src/lib/services/` for extracted business logic).
- **Shared types** (entities, DTOs) go in `src/types.ts`.

### Environment

- Node.js v22.14.0 (see `.nvmrc`)
- Env vars: `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (copy `.env.example` to `.env` for Node, or `.dev.vars` for Cloudflare local dev)
- `SUPABASE_SERVICE_ROLE_KEY` comes from the dashboard (Settings → API → `service_role`). It bypasses RLS, so it is server-only — without it `createServiceClient()` returns `null` and every run-state call fails with `not_configured`.
- Local Supabase: `npx supabase start` (requires Docker)
- Cloudflare local dev: secrets go in `.dev.vars` (gitignored)
- Deploy: `npx wrangler deploy` (requires Cloudflare account + `wrangler` auth)

## CI

GitHub Actions workflow (`.github/workflows/ci.yml`) runs lint + build on every push and PR to master. Requires `SUPABASE_URL` and `SUPABASE_KEY` repository secrets for the build step.
