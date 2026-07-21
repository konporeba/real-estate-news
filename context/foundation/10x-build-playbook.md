# 10x Build Playbook — from notes to working software

A single, continuous execution flow. Do the **Prerequisite** once, then run steps 1–20 in order. Loop steps 8–18 once per slice until the MVP's slices are done.

**The artifact chain you are building** (each file is a different zoom level on the same project — keep them separate):
`shape-notes.md → prd.md → tech-stack.md → roadmap.md → task (change-id) → context/changes/<change-id>/plan.md → code`

**Two rules that apply to every step below:**

- If a CLI can do the job, delegate to it (e.g. `npm create astro`, `prisma migrate`, `docker init`) instead of letting the agent generate from memory.
- Don't mix zoom levels — business (PRD), technical (tech-stack), sequencing (roadmap), and per-change (plan) each stay in their own artifact.

---

## Prerequisite — install all 10x skills once (global, reusable, durable)

Do this a single time so every skill below is available in **all** your projects, survives the CLI being removed, and can still be updated. Grounded in the [10x-cli README](https://github.com/przeprogramowani/10x-cli).

1. **Authenticate once** (magic link to your Circle-registered email):

   ```bash
   npx @przeprogramowani/10x-cli@latest auth
   ```

2. **Pull ALL skills into your global Claude skills folder** in one shot. The CLI writes to `.claude/` relative to the current directory, and `~/.claude/skills/` is the location Claude Code loads in every project — so run it from home:

   ```bash
   cd ~
   npx @przeprogramowani/10x-cli@latest sync --all --tool claude-code --no-course-rules
   ```

   `--all` = every unlocked lesson at once; `--no-course-rules` = skills only, no course rules block in your global `CLAUDE.md`.

3. **Make it durable and versioned** — turn the folder into a private git repo (your permanent copy + change history), and stash a standalone CLI binary as insurance:

   ```bash
   cd ~/.claude/skills && git init && git add . && git commit -m "10x skills snapshot"
   # optional: push to a PRIVATE remote as backup
   ```

   Also download a standalone binary from https://github.com/przeprogramowani/10x-cli/releases and keep it, so the tool works even if the npm package disappears.

4. **Update whenever you want:**
   ```bash
   cd ~ && npx @przeprogramowani/10x-cli@latest sync --all --no-course-rules
   ```
   Skips unchanged lessons cheaply; if you edited a skill locally it keeps your version and prints the exact `10x get …` command to take the update. Commit after each sync for a full history.

**Notes.** Lessons unlock over the 6 weeks, so `sync --all` grabs everything available _now_ — re-run it as more unlock. The CLI is MIT-licensed, but the skill _content_ is gated by your paid course account: keep the copy for your own projects and keep that repo **private** (publishing it would breach the course terms).

_(Alternative to the global approach: run `sync --all` in one dedicated `10x-skills` repo and symlink its `skills/` into each project. Global `~/.claude/skills` is the least-effort option for "all my projects.")_

---

## Shape and specify

1. **Turn raw notes into shape-notes** — `/10x-shape`
   The agent runs a Socratic session: asks, digs, catches gaps. You describe _what_ you're building; it doesn't invent scope. In an existing repo it auto-switches to brownfield mode ("what to add/fix?").
   → Produces `shape-notes.md` (decisions, open questions, deferred items).

2. **Generate the PRD** — `/10x-prd`
   Rewrites `shape-notes.md` faithfully into a structured contract: user stories, prioritized functional requirements, success criteria, Non-Goals. Anything missing lands in `## Open Questions`.
   → Produces `context/foundation/prd.md`.

3. **Close the PRD gaps (gate).** Read `## Open Questions`, answer them, re-run/edit until the PRD is real. Beware the "phantom PRD" — a document that looks complete but decided nothing. Don't proceed until the contract actually constrains the build.

## Choose stack and stand up the skeleton

4. **Select the tech stack** — `/10x-tech-stack-selector @context/foundation/prd.md`
   Reads project type, timeline, and requirements from the PRD; recommends from a vetted starter registry. Includes a "Why this stack" section tying choices back to the PRD.
   → Produces `context/foundation/tech-stack.md` (with `starter_id`, `bootstrapper_confidence`, capability flags).
   _(Existing codebase instead of greenfield: `/10x-stack-assess`.)_

5. **Bootstrap the project skeleton** — `/10x-bootstrapper @tech-stack.md`
   Refuses to run without `tech-stack.md` (pre-execution gate), then delegates to the official starter CLI to scaffold a correct, current project rather than writing boilerplate from training data. Audits the result.
   → Produces the running skeleton + `verification.md` (status of each phase, `npm audit`).
   _(Existing project instead of new: `/10x-health-check`.)_

6. **Onboard the agent to the repo** — `/init`, then `/10x-agents-md` and `/10x-rule-review`
   Generate the first rules draft, clean it up, and validate quality.
   → Produces `CLAUDE.md` / `AGENTS.md` (instruction hierarchy the agent will follow every session).

## Plan the whole build

7. **Build the roadmap** — `/10x-roadmap`
   Vertical-first decomposition. Start from the "north star slice" — the smallest working flow that proves the product thesis. Slices are `S-XX` (full-stack, user-visible); foundations are `F-XX` (technical enablers). Every `F-XX` must declare `Unlocks: S-XX` or it gets parked (no horizontal drift disguised as "fundamentals").
   → Produces `roadmap.md` (Foundations, Slices, dependencies, blockers, unknowns) + a starter backlog.

## Per-slice build loop — repeat 8–18 for each S-XX (and its F-XX enablers)

8. **Pick the next change** from the roadmap and create its change folder (change-id = the intent of the work). Do foundations first only where a slice is blocked.

9. **Research first for anything non-trivial** — `/10x-research`
   External research (agent-friendly docs/libraries) + internal research (your own codebase) before planning. Contract-level decisions (e.g. which SRS/library) get resolved here, not mid-code.
   _(If a plan won't converge or the agent starts cascading errors / context drift, use `/10x-frame` as the recovery lever.)_

10. **Write the implementation plan** — `/10x-plan <change-id>`
    → Produces `context/changes/<change-id>/plan.md` (+ `plan-brief.md`): architecture of this one slice, phases, files touched, contract surfaces, `## Progress` block.

11. **Review the plan before any code (gate)** — `/10x-plan-review <change-id>`
    Checks: does the plan answer the roadmap task? Is the end state concrete? Are phases executable without skipping decisions? Are contract surfaces named? Does `## Progress` have a format `/10x-implement` can update? Do success criteria test _behavior_, not just that files exist? Fix here — it's the cheapest place to fix anything.

12. **Plan the tests (risk-based)** — `/10x-test-plan`
    Build a risk map and the quality gates that must pass before production. Prioritize by risk (include a security axis); don't chase coverage for its own sake.
    → Produces the test plan / risk map artifact.

13. **Implement phase by phase** — `/10x-implement <change-id> phase N`
    The agent holds to one phase, reports touched files, runs the agreed verification commands, stops at manual gates where the plan requires a human decision, commits, and records the commit SHA/status in `## Progress`. Advance phases one at a time.

14. **Write unit/integration tests** through the research → plan → implement cycle; use `/10x-tdd` for brand-new functionality where test-first fits.

15. **Write E2E tests** — `/10x-e2e`
    Playwright-driven; hooks into `/10x-implement` and `/10x-tdd`. Use vision/multimodal mode when the DOM isn't enough. Green is not enough — verify the scenario actually exercises the user flow, and isolate test data.

16. **Review the implementation before merge** — `/10x-impl-review` (solo scorecard + verdict); `/10x-impl-review-ci` to run it in the pipeline.
    Triage findings by severity rather than "fix everything"; read the agent's diff critically; get an explicit merge verdict.

17. **Merge** once the plan's success criteria and quality gates are green and `## Progress` is updated.

18. **Repeat from step 8** for the next slice until every MVP slice from the roadmap is done.

## Ship

19. **Decide infrastructure** — `/10x-infra-research`
    Use anti-confirmation-bias prompting so you get real trade-offs, not options flattered to your preferences.
    → Produces `infrastructure.md` (the deployment contract).

20. **Deploy** using Plan Mode: agent proposes the deployment plan, you approve, it executes — keeping a controlled boundary around production access.

---

### Definition of "MVP done"

Every roadmap slice (`S-XX`) implemented behind passing quality gates and E2E scenarios, each change's `## Progress` closed out, reviewed and merged, and the app deployed per `infrastructure.md`.
