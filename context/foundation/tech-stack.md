---
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
---

## Why this stack

A solo operator's single-user web app whose dashboard is thin but whose engine
is a multi-day, stateful, scheduled AI pipeline. The 10x Astro Starter is the
recommended default for `(web, js)` and clears all four agent-friendly gates,
giving the dashboard PIN-gate auth, the full-fidelity archive, and durable
in-flight state via Supabase (Postgres + auth + storage) in one typed stack.
Deployment is self-host, not the starter's Cloudflare default, because US-22
requires a private, non-public dashboard and the whole system runs on the
client's home machine — the edge runtime is also wrong for long-running work,
so the collection/ranking/generation pipeline runs as a separate long-lived
Node worker against the same Supabase database. Auth and AI flags are set;
background-jobs is set for the weekly scheduler, catch-up, retries, cost
ceiling, and heartbeat. Payments and realtime are out of scope. CI on GitLab
with manual promotion, so a merge never auto-restarts the machine mid-run.
Bootstrapper confidence is first-class. The starter is the app shell only —
the pipeline, LLM work, cost ceiling, eval harness, and visual-template
autofill are custom builds on top.
