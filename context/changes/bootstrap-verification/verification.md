---
bootstrapped_at: 2026-07-21T17:48:08Z
starter_id: 10x-astro-starter
starter_name: 10x Astro Starter (Astro + Supabase + Cloudflare)
project_name: real-estate-news
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: npm audit --json
---

## Hand-off

Verbatim from `context/foundation/tech-stack.md`:

```yaml
starter_id: 10x-astro-starter
package_manager: npm
project_name: real-estate-news
hints:
  language_family: js
  team_size: solo
  deployment_target: self-host
  ci_provider: gitlab-ci
  ci_default_flow: manual-promotion
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: true
  has_background_jobs: true
```

**Why this stack** (from hand-off body): A solo operator's single-user web app
whose dashboard is thin but whose engine is a multi-day, stateful, scheduled AI
pipeline. The 10x Astro Starter is the recommended default for `(web, js)` and
clears all four agent-friendly gates, giving the dashboard PIN-gate auth, the
full-fidelity archive, and durable in-flight state via Supabase (Postgres + auth

- storage) in one typed stack. Deployment is self-host, not the starter's
  Cloudflare default, because US-22 requires a private, non-public dashboard and
  the whole system runs on the client's home machine — the edge runtime is also
  wrong for long-running work, so the collection/ranking/generation pipeline runs
  as a separate long-lived Node worker against the same Supabase database. Auth and
  AI flags are set; background-jobs is set for the weekly scheduler, catch-up,
  retries, cost ceiling, and heartbeat. Payments and realtime are out of scope. CI
  on GitLab with manual promotion, so a merge never auto-restarts the machine
  mid-run. Bootstrapper confidence is first-class. The starter is the app shell
  only — the pipeline, LLM work, cost ceiling, eval harness, and visual-template
  autofill are custom builds on top.

## Pre-scaffold verification

| Signal      | Value                                                     | Severity | Notes                                                           |
| ----------- | --------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| npm package | not run                                                   | —        | cmd_template starts with `git clone`; no create-\* CLI to check |
| GitHub repo | przeprogramowani/10x-astro-starter last pushed 2026-05-17 | fresh    | from card.docs_url; ~2 months before bootstrap date             |

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone (cloned starter repo, upstream `.git/` deleted before move-up)
**Exit code**: 0
**Files moved**: 20 top-level entries (.env.example, .github, .gitignore, .husky, .nvmrc, .prettierrc.json, .vscode, astro.config.mjs, CLAUDE.md, components.json, eslint.config.js, node_modules, package.json, package-lock.json, public, src, supabase, tsconfig.json, wrangler.jsonc — plus README.md sidelined)
**Conflicts (.scaffold siblings)**: README.md → README.md.scaffold (cwd already had a README.md; existing wins)
**.gitignore handling**: moved silently (cwd had no .gitignore)
**context/ handling**: cwd `context/` preserved verbatim; starter shipped no `context/` directory
**.bootstrap-scaffold cleanup**: deleted

## Post-scaffold audit

**Tool**: npm audit --json
**Summary**: 1 CRITICAL, 8 HIGH, 7 MODERATE, 2 LOW (18 total)
**Direct vs transitive**: 3 direct / 15 transitive across all severities (npm audit distinguishes direct dependencies)

#### CRITICAL / HIGH findings (package-level)

Advisories were reported against the following packages (high + critical tier):
`astro`, `brace-expansion`, `devalue`, `js-yaml`, `miniflare`, `tar`, `undici`,
`vite`, `ws`. Most are transitive (pulled in by Astro, the Cloudflare adapter
/ Miniflare, and the build toolchain); `astro` and `vite` are the notable
direct/near-direct entries. `npm audit fix` addresses the bulk; a few may
require `npm audit fix --force` (which can introduce a breaking major bump —
review before running).

#### MODERATE findings

7 moderate advisories, all transitive. Log-only per bootstrapper policy; see
`npm audit` output for the full list.

#### LOW / INFO findings

2 low advisories, transitive. Log-only.

**Note**: This audit is informational (WARN-AND-CONTINUE). Bootstrapper does not
auto-fix. Vulnerability counts on a fresh Astro/Cloudflare scaffold are common
and largely transitive; run `npm audit` for the itemized report and decide fixes
per your risk tolerance.

## Hints recorded but not acted on

| Hint                    | Value            |
| ----------------------- | ---------------- |
| bootstrapper_confidence | first-class      |
| quality_override        | false            |
| path_taken              | standard         |
| self_check_answers      | null             |
| team_size               | solo             |
| deployment_target       | self-host        |
| ci_provider             | gitlab-ci        |
| ci_default_flow         | manual-promotion |
| has_auth                | true             |
| has_payments            | false            |
| has_realtime            | false            |
| has_ai                  | true             |
| has_background_jobs     | true             |

v1 records these for audit-trail completeness. It does not generate CI/CD
workflows, auth scaffolding, or feature-specific code from these hints — that is
deferred to a future skill.

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:

- `git init` (if you have not already) to start your own repo history.
- Review any `.scaffold` siblings the conflict policy created and decide which version of each file to keep (here: `README.md` vs `README.md.scaffold`).
- The starter shipped its own `CLAUDE.md` — review it; it documents the Astro + Supabase + Cloudflare conventions the agent should follow.
- Address audit findings per your project's risk tolerance — the full breakdown is in this log; run `npm audit` for the itemized report.
- Configure Supabase (`supabase/` directory) and copy `.env.example` to `.env` with your project's keys before running the app.
- Deployment is self-host per the hand-off — the starter ships a `wrangler.jsonc` (Cloudflare); revisit deployment config for the home-machine target, e.g. via `/10x-infra-research`.
