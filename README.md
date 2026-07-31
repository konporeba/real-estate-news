# Real Estate News

A weekly automation pipeline that turns Spanish and Catalan real-estate news into a ranked, translated Polish shortlist — built for a real-estate professional serving Polish investors and expats in Barcelona / Catalonia.

## The problem this solves

The manual workflow — read Spanish sources, judge what matters to a Polish audience, translate, design a post, publish — is too time-expensive to sustain weekly, so it doesn't happen: zero social posts, despite an abundance of relevant news every week. The social publishing integration itself is already solved (reused from a prior project); everything *upstream* of publishing — gathering, editorial judgment, translation — was the gap.

The differentiator is the editorial judgment, not the scraping: a **geography-first rubric** that ranks stories by how close their effects land to a Barcelona/Catalonia audience (Catalonia first, Spain-wide national next, global-with-Spanish-impact after), and whether they touch money or regulation. Two human decisions stay irreducible by design: which stories to publish, and final approval before anything goes out.

## How it works

```
collect  →  rank (cluster + geography-score)  →  translate  →  operator dashboard
                                                                        ↓
                                        select → generate copy → brand visuals → approve → publish
```

- **Collect** — pulls articles from a tiered source list (RSS → API → rendered fetch), resilient to a blocked source or a thin news week.
- **Rank** — clusters same-story articles (coverage count as a relevance boost, not redundancy), then scores each cluster against the geography rubric. Gated by an eval harness (`RANKING_EVAL=1 npm test`) that checks any rubric change against a held-out labeled set before it ships.
- **Translate** — the shortlisted stories' title + lede get translated to Polish, original alongside.
- **Dashboard** — the operator reviews the ranked, translated shortlist behind a PIN-gated private view.
- **Downstream** (in progress) — story selection, Polish copy generation with a numeric-integrity gate, brand visual assets, an approval gate, and scheduled per-platform publishing.

See `context/foundation/roadmap.md` for the full slice-by-slice build plan and `context/foundation/prd.md` for the product requirements.

## Tech stack

- [Astro 6](https://astro.build/) (SSR) + [React 19](https://react.dev/) islands + [Tailwind 4](https://tailwindcss.com/) — the operator-facing app, deployed to Cloudflare Workers
- A plain-Node pipeline worker (`src/worker/`, run via [tsx](https://github.com/privatenumber/tsx)) for collection, ranking, and scheduling — kept deliberately separate from the Cloudflare workerd runtime (see "Two runtimes" in `CLAUDE.md`)
- [Supabase](https://supabase.com/) (Postgres) for the digest/article/cluster schema and durable run-state, with `@supabase/ssr` for cookie-based sessions
- [Anthropic Claude](https://www.anthropic.com/) via a budgeted, retry-safe invocation harness (`src/lib/llm/`) — every model call enforces a hard per-digest cost ceiling
- [shadcn/ui](https://ui.shadcn.com/) ("new-york" variant) for components

## Getting started

Requires Node.js v22.14.0 (see `.nvmrc`).

```bash
npm install
cp .env.example .env   # fill in Supabase + Anthropic credentials
npm run dev             # dev server (Cloudflare workerd runtime)
```

Common commands:

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build (SSR) |
| `npm test` | Unit tests (Vitest); integration suites are opt-in, see `CLAUDE.md` |
| `npm run collect` | Run the weekly source-collection worker |
| `npm run rank` | Run the ranking worker on a digest `collect` left in `ranking` |
| `npm run lint` / `npm run format` | ESLint / Prettier |

Full command reference, architecture conventions, and the two-runtime boundary are documented in `CLAUDE.md`.

## Status

Single-operator internal tool, actively under development. See `context/foundation/roadmap.md` for what's shipped and what's next.
