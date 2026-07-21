---
project: "Spanish Real Estate News Digest"
context_type: greenfield
product_type: web-app
created: 2026-07-20
updated: 2026-07-20
target_scale:
  users: small # single operator (the client)
  qps: low
  data_volume: small # weekly digests + archive on a Raspberry Pi
timeline_budget:
  mvp_weeks: null # deliberately unbounded — quality-first, not time-boxed (see Open Question #9)
  hard_deadline: null
  after_hours_only: false
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "collection strategy"
      decision: "per-source tiering RSS -> API -> rendered scraping; AI web search last resort"
    - topic: "dedup vs coverage"
      decision: "semantic clustering; coverage count is a ranking boost, not redundancy"
    - topic: "ranking signal"
      decision: "geography-first rubric (Catalonia > Spain-national > global-with-Spanish-impact > other-regional); title+lede, relevance not recency"
    - topic: "numeric integrity"
      decision: "deterministic numeral assertion, not a prompt promise; failure fails the run"
    - topic: "auth model"
      decision: "single operator; 6-digit PIN + lockout + rate limiting, behind Cloudflare Tunnel"
    - topic: "deadline behavior"
      decision: "missed Tuesday 17:00 approval -> skip auto-publish, remain manually publishable; never publish unapproved content"
    - topic: "timezone"
      decision: "named zone Europe/Warsaw, never a fixed offset (DST safety)"
    - topic: "run durability"
      decision: "three-day durable, resumable workflow with per-stage checkpoints, not a single long job"
    - topic: "output formats"
      decision: "single post or carousel only; infographics dropped permanently; podcast parked as fast-follow"
  frs_drafted: 28
  quality_check_status: warned
---

# Shape Notes — Spanish Real Estate News Digest

**Status:** Shaping session complete. Ready for `/10x-prd`.
**Mode:** Greenfield (reuses proven publishing integration from a prior project).
**Author context:** Built for a single client (the author's brother), a real estate professional serving Polish investors and expats in Spain.

**Editorial focus:** Primarily **Barcelona and Catalonia**. But the net is cast wider than that, so nothing important is missed: **Spain-wide developments that affect the property market nationally** — mortgage rules, tax changes, national price trends, ECB decisions — matter regardless of where they originate, because they affect Catalonia too. What is _not_ wanted is other regions' purely local news: a Madrid neighbourhood rezoning or a Valencia municipal dispute has no bearing on this audience.

---

## 1. Vision & Problem

**Today:** The client publishes nothing on social media. Not from lack of material — Spanish real estate news is abundant — but because the manual workflow is too expensive in time: read Spanish sources, judge what matters to a Polish audience, translate, design a post, publish. Every week. It never happens.

**The change:** Go from _zero posts_ to _consistent weekly posts_ without the week being consumed. The machine gathers, judges, translates and designs; the human makes only the two decisions that require his judgment.

**Why now:** The publishing pipeline (Instagram, Facebook, LinkedIn) is already built and validated in a prior project for the same client. The remaining gap is everything upstream of publishing.

**Success looks like:** He posts every week, and the weekly time cost is minutes, not hours.

---

## 2. Persona & Access Control

**Single operator.** One user, the client. No multi-tenancy, no roles, no user management, no invitations.

**Auth:** 6-digit PIN, behind a Cloudflare Tunnel.

- Lockout after ~5 failed attempts, plus rate limiting.
- Rationale: a 6-digit PIN alone is ~10^6 combinations and this app can post to real business social accounts. Lockout + rate limiting makes brute force impractical while keeping the UX as simple as the client wants. _Flagged during shaping and accepted with mitigation._

---

## 3. MVP Discipline

**First valuable flow, end to end:** Sunday collection → ranked Polish shortlist → operator selects → generation → operator approves → Tuesday publish → archived.

Everything in the FR list below is inside that flow. Nothing is speculative infrastructure.

**Deliberately deferred** (see Non-Goals): infographics (dropped permanently), podcast digest (fast-follow), any second user.

**Timeline stance:** This is _not_ a time-boxed, after-hours build. The operator has stated that the reliability and quality of the delivered solution is the priority over shipping fast — this is a real product for a real client. `mvp_weeks` is therefore left unbounded rather than fabricated; scope is controlled by the MVP flow above and the non-goals, and quality is gated by the eval harness (FR-026), deterministic numeric check (FR-014), and the two human gates. See Open Question #9.

---

## 4. Weekly Operating Rhythm

| When                      | What                                            |
| ------------------------- | ----------------------------------------------- |
| Mon 00:00 – Sun 23:59     | Collection window (the week being reported on)  |
| Sun 17:00                 | Scrape + rank + translate shortlist runs        |
| Sun, on completion        | Email: "digest ready for selection"             |
| Sun → Tue                 | Operator selects stories, format, platforms     |
| After generation          | Email: "content ready for approval"             |
| Mon 09:00                 | Reminder email if any step is not yet validated |
| Tue 17:00 `Europe/Warsaw` | Scheduled publish of approved content           |

**Timezone is a named zone (`Europe/Warsaw`), never a fixed offset.** "5PM CET" is CEST for half the year — storing an offset is a guaranteed one-hour bug at the DST switch.

**The scrape runs Sunday 17:00.** Note the trade-off this creates: news published between 17:00 and 23:59 on Sunday falls inside the declared Monday–Sunday window but will not have been collected. Two clean resolutions — either declare the window as Monday 00:00 → Sunday 17:00, or let late-Sunday items roll into the following week's digest. **Open Question #7.**

**A run spans three days, not three minutes.** This is the single biggest architectural consequence of the rhythm: state must survive from Sunday's scrape through Monday's reminder to Tuesday's publish. This is a durable, resumable workflow with per-stage checkpoints — not a single long-running job. Live status polling is only needed during the generation step; everywhere else the operator is away from the screen.

---

## 5. Functional Requirements

### Collection

- **FR-001** — The system collects articles published within the Monday–Sunday window from a configured source list.
- **FR-002** — Collection is **tiered per source**, not one global method:
  1. **RSS feed** where the source publishes one (preferred — structured, stable, no blocking).
  2. **News API / aggregator** as second choice.
  3. **Rendered scraping** (e.g. Firecrawl) only for sources that offer neither. Idealista in particular is aggressive about blocking scrapers.
     Each source is configured with its own method. _This replaces the original "scrape everything, fall back to AI web search" design._
- **FR-003** — If the pool is below a configured threshold, fallback sources are added; AI web search remains the last resort.
- **FR-018** — A manual re-trigger exists for the collection run. If Sunday's run fails, the week must be recoverable without waiting seven days.

### Ranking (the editorial brain)

- **FR-004** — Candidate articles are **semantically clustered**, not deduplicated by URL. The same story covered by Idealista, Cinco Días and El Economista is one story with three sources.
- **FR-005** — **Coverage count is a ranking boost.** A story carried by four outlets is more important, not more redundant. Dedup is inverted into a relevance signal.
- **FR-006** — Ranking input is **title + lede/meta description**, not title alone. Headlines are SEO-optimised and oversell; judging on titles alone means judging stories by their advertising. Still cheap enough to score the full pool in one call.
- **FR-007** — Each cluster receives a relevance score from an LLM scoring rubric:
  - **Geography drives the score.**
    - **Catalonia / Barcelona — 8–10.** The core focus.
    - **Spain-wide, nationally applicable — 5–7.** National mortgage rules, tax law, nationwide price and rental trends, Bank of Spain data. These apply _to_ Catalonia as well, which is why they score above other regions.
    - **Global with direct Spanish market impact — 3–5.** ECB rate decisions, EU-level property or residency regulation.
    - **Other regions' purely local news — 0–2.** Madrid or Valencia municipal matters with no national read-across. Scored to be discarded.
  - **The critical distinction is national vs. other-regional, not Catalonia vs. everything else.** A Bank of Spain mortgage change is not "Madrid news" simply because it was announced there — it is national, and it reaches this audience. A Madrid neighbourhood rezoning does not. The rubric must be written so the model separates _where a story was published_ from _where its effects land_; this is the most likely place for it to misjudge.
  - **Topic refines it.** Rental prices, purchase prices, mortgage rates, new construction and regulatory change are boosted; unrelated local or purely political news sinks.
- **FR-008** — Ranked by **relevance, not recency**. Top 15 clusters are kept.
- **FR-009** — The shortlist is batch-translated to Polish in one cheap call. Translation is idempotent — articles translated at shortlist stage are not re-translated later.
- **FR-009a** — **Both languages are retained and displayed.** The shortlist shows the original Spanish title/lede alongside the Polish translation; the original is never discarded. Each is marked with a **visual language indicator (flag)** so the operator can tell at a glance which text he is reading, and can fall back to the Spanish original to verify a translation that reads oddly.

### Human gate 1 — selection

- **FR-010** — Sunday email notifies the operator the digest is ready.
- **FR-011** — The dashboard presents the ranked, translated shortlist. **Multi-source stories display as one entry** annotated with its coverage ("covered by 3 sources"), with the underlying sources available as material for the post.
- **FR-012** — The operator selects **2–4 stories**, an **output format** (single post _or_ carousel), and **target platforms** (Instagram, LinkedIn, Facebook).

### Generation

- **FR-013** — Only selected stories get full treatment: complete Spanish → Polish translation adapted for social media — compelling title, caption-ready summary, longer body copy for slides, and key statistics pulled out.
- **FR-014** — **Numeric integrity is verified deterministically, not promised in a prompt.** Numerals (prices, percentages, dates) are extracted from the source and asserted present in the output. Failure fails the run. No LLM involved in the check.
- **FR-015** — Visual output is produced via **Canva brand templates with autofill**. The operator owns the design in Canva's editor; the agent fills named slots. **One template per platform format** (Instagram square, LinkedIn ratio, etc.). Design changes require no code change.
- **FR-016** — A hard **per-run cost ceiling** is enforced (`maxBudgetUsd` / `maxCost`, depending on SDK). A malformed-JSON retry loop on an unattended weekly job is exactly the failure that bills quietly overnight.
- **FR-017** — Malformed LLM output is handled with staged JSON recovery plus backoff retries — bounded by FR-016.

### Human gate 2 — approval

- **FR-019** — On generation completion, the operator is emailed that content is ready for approval.
- **FR-020** — The operator reviews the generated post and approves or rejects before anything publishes.
- **FR-021** — Monday reminder email if any step remains unvalidated.

### Publishing

- **FR-022** — Approved content publishes Tuesday 17:00 `Europe/Warsaw` to the selected platforms. Per-platform success/failure is tracked independently; post IDs or error messages are recorded.
- **FR-023** — **Missed-deadline behavior:** if Tuesday 17:00 arrives without approval, the scheduled publish is **skipped**. The digest remains in an approved-and-pending state and the operator can publish manually from the dashboard at any later time. The system never publishes unapproved content — that would defeat the human-in-the-loop premise. Whether stale content is still worth posting is the operator's call, not the system's.

### Archive & learning

- **FR-024** — **Full-fidelity archive.** Every digest is retained as it was: the shortlist presented, which stories were picked _and which were passed over_, generated copy, Canva output, target platforms, and per-platform results.
- **FR-025** — **Feedback loop.** The weekly picks-vs-passes are captured as labeled examples and fed back into the ranking prompt as few-shot material, so the rubric converges on the operator's actual taste rather than a generic notion of newsworthiness. FR-024 and FR-025 are the same storage decision — the archive is what makes the learning loop possible.
- **FR-026** — **Eval harness for the ranking prompt.** A fixed set of example articles with known-correct scores is run against the rubric before any prompt change ships. The rubric carries the business logic; a prompt that carries business logic needs a regression gate.

### Operations

- **FR-027** — Scheduling uses a mechanism that **catches up on missed runs** (systemd timer with `Persistent=true`, or a startup check for a missed window). Plain cron silently skips a run if the machine is off — that kills the week.
- **FR-028** — **Heartbeat / dead-man's-switch.** Silence from a home server is ambiguous. A success email tells him it worked; nothing currently tells him it didn't. A periodic ping to an external monitor closes that gap.

---

## 6. User Stories

All stories are from the perspective of the single operator (the client), unless marked as a system behavior.

### Collection

**US-001 — Weekly digest is prepared without me asking**
_Given_ the collection window Monday–Sunday has closed,
_When_ the scheduled Sunday evening run executes,
_Then_ articles from all configured sources are collected, clustered, scored and shortlisted,
_And_ I receive an email telling me the digest is ready for selection.

**US-002 — A failed run doesn't cost me the week**
_Given_ the Sunday run failed or the machine was offline,
_When_ I open the dashboard and trigger the run manually,
_Then_ collection executes against the same Monday–Sunday window,
_And_ the digest proceeds as normal.

**US-003 — A blocked source doesn't break collection** _(system)_
_Given_ one configured source fails to respond or blocks the request,
_When_ collection runs,
_Then_ the remaining sources are still collected,
_And_ the failure is recorded against that source rather than failing the digest.

**US-004 — A thin week still produces a digest** _(system)_
_Given_ primary sources yield fewer articles than the configured threshold,
_When_ collection completes,
_Then_ fallback sources are added,
_And_ if the pool is still below the minimum, AI web search runs as a last resort.

### Ranking and shortlist

**US-005 — I read the shortlist in Polish, with the Spanish original available**
_Given_ the digest has reached `ready_for_selection`,
_When_ I open the dashboard,
_Then_ I see the top 15 stories with Polish titles and summaries,
_And_ the original Spanish title and lede are shown alongside them,
_And_ each is marked with a flag indicating its language,
_And_ I can make my decision in Polish while still being able to check the original wording.

**US-006 — The most relevant stories are at the top**
_Given_ the week contained both Barcelona rental-price news and Madrid political news,
_When_ I view the shortlist,
_Then_ the Barcelona rental-price story ranks above the Madrid political story,
_And_ ordering reflects relevance rather than publication time.

**US-007 — One story appears once**
_Given_ the same story was covered by Idealista, Cinco Días and El Economista,
_When_ I view the shortlist,
_Then_ I see a single entry annotated "covered by 3 sources",
_And_ that entry ranks higher than an equivalent story covered by one outlet,
_And_ I can see the underlying sources if I want them.

**US-008 — I'm not misled by a headline** _(system)_
_Given_ an article whose headline oversells its content,
_When_ relevance is scored,
_Then_ the score is computed from the title _and_ the lede/meta description,
_And_ not from the headline alone.

### Selection (human gate 1)

**US-009 — I choose what gets published**
_Given_ I am viewing the ranked shortlist,
_When_ I select between 2 and 4 stories, choose a format (single post or carousel), and choose target platforms,
_Then_ the digest moves to `generating`,
_And_ only my selected stories receive the expensive full treatment.

**US-010 — My choices are remembered as signal** _(system)_
_Given_ I selected 3 stories from a shortlist of 15,
_When_ selection is confirmed,
_Then_ both the 3 picks and the 12 passes are stored as labeled examples,
_And_ they become available as few-shot material for future ranking.

### Generation

**US-011 — Copy is written for social media, not translated literally**
_Given_ my selected Spanish articles,
_When_ generation runs,
_Then_ I receive a compelling Polish title, a caption-ready summary, body copy suited to the chosen format, and pulled-out key statistics,
_And_ the tone is adapted for social media rather than being a literal translation.

**US-012 — Numbers are never invented or drifted**
_Given_ a source article containing prices and percentages,
_When_ the generated Polish copy is produced,
_Then_ every numeral extracted from the source is asserted present in the output,
_And_ if any is missing or altered, the run fails rather than publishing wrong figures.

**US-013 — I control the design without touching code**
_Given_ I have edited my brand template in Canva's editor,
_When_ the next digest generates visual output,
_Then_ the new design is used,
_And_ no code change or deployment was required.

**US-014 — Output is correctly sized per platform**
_Given_ I selected Instagram and LinkedIn as targets,
_When_ visual output is generated,
_Then_ each platform's asset is produced from the template matching that platform's format.

**US-015 — A malfunctioning run cannot run up a bill** _(system)_
_Given_ the model repeatedly returns malformed output and retries are triggered,
_When_ the accumulated cost for the run reaches the configured ceiling,
_Then_ the run halts,
_And_ the failure is recorded for manual re-trigger.

### Approval (human gate 2)

**US-016 — Nothing publishes that I haven't seen**
_Given_ generation has completed,
_When_ the content is ready,
_Then_ I receive an email notification,
_And_ the digest waits in `ready_for_approval` until I explicitly approve it.

**US-017 — I'm reminded before the deadline, not after**
_Given_ it is Monday and the digest is not yet approved,
_When_ the reminder job runs,
_Then_ I receive an email telling me which step is outstanding,
_And_ I have a full day before the scheduled publish.

### Publishing

**US-018 — Approved content publishes on schedule**
_Given_ the digest is approved,
_When_ Tuesday 17:00 `Europe/Warsaw` arrives,
_Then_ the content is published to each selected platform,
_And_ per-platform success or failure is recorded independently with post IDs or error messages.

**US-019 — A missed deadline doesn't publish unapproved content**
_Given_ Tuesday 17:00 arrives and I have not approved the digest,
_When_ the scheduled publish job runs,
_Then_ the publish is skipped,
_And_ the digest remains available for me to publish manually from the dashboard at any later time.

**US-020 — One platform failing doesn't lose the others**
_Given_ publishing succeeds on LinkedIn but fails on Instagram,
_When_ the publish job completes,
_Then_ the LinkedIn post remains live and recorded as successful,
_And_ the Instagram failure is recorded with its error message.

### Archive

**US-021 — I can see everything I've published**
_Given_ previous digests have been published,
_When_ I open the archive,
_Then_ I can see, for each week, the shortlist I was shown, which stories I picked and passed, the generated copy, the visual output, the target platforms, and the per-platform result.

### Access

**US-022 — Only I can operate the system**
_Given_ the dashboard is exposed via Cloudflare Tunnel,
_When_ someone enters an incorrect PIN 5 times,
_Then_ further attempts are locked out and rate limited,
_And_ access to the publishing controls is not obtainable by guessing.

### Operations

**US-023 — Silence is never ambiguous** _(system)_
_Given_ the Raspberry Pi is powered off or the scheduler has stalled,
_When_ the expected heartbeat is not received,
_Then_ an external monitor raises an alert,
_And_ I learn that nothing ran, rather than assuming there was simply no news.

**US-024 — A missed schedule window is caught up** _(system)_
_Given_ the machine was offline at the scheduled Sunday run time,
_When_ it comes back online,
_Then_ the scheduler detects the missed window and executes the run,
_And_ the week is not silently lost.

**US-025 — Changing the rubric doesn't silently break it** _(developer)_
_Given_ I have modified the relevance scoring prompt,
_When_ I run the eval harness against the fixed set of known-correct examples,
_Then_ I see whether scores drifted from expected values,
_And_ I can catch a regression before the operator ever sees a bad shortlist.

---

## 7. Business Logic (the domain rule)

> **A story is worth publishing when it is geographically close to the audience (Barcelona/Catalonia > Spain-wide > global-with-Spanish-impact) and touches money or regulation — ranked by relevance rather than recency, reinforced by how many outlets carried it, and confirmed by the operator.**

This is not a CRUD app. The editorial rubric _is_ the product — it is what makes this a domain-specific tool rather than a generic news scraper. It lives in a prompt, is versioned, is regression-tested (FR-026), and improves from operator feedback (FR-025).

---

## 8. Data Model (sketch)

- **digest** — one weekly run; state, window start/end, timestamps, cost
- **article** — source URL, source name, published date, original title/lede, Polish translation
- **cluster** — groups articles telling the same story; relevance score, coverage count, rank
- **selection** — which clusters the operator picked _and passed_, chosen format, chosen platforms
- **generated_asset** — Polish copy, key statistics, Canva output reference
- **publication** — per platform: status, post ID or error
- **feedback_label** — derived from selection; the training material for FR-025

**Media on a Pi:** rendered images are heavier than DB rows. Store Canva output as files with the database holding paths. _Implementation detail — settled at the stack step._

---

## 9. Digest State Machine

`collecting → ranking → ready_for_selection → generating → ready_for_approval → approved → published`

Terminal / branch states: `skipped` (deadline passed unapproved, publishable manually), `failed` (re-triggerable per FR-018).

---

## Forward: tech-stack — Hosting & Deployment Constraints

_This block is informational for the downstream `/10x-tech-stack-selector` step. It is NOT part of the PRD schema and must not be folded into PRD sections._

**Runs on a Raspberry Pi 5 already owned by the developer.** Sound fit — the workload is API-bound, not compute-bound; the Pi mostly waits on the network. Beats paying for a cloud box idle 167 hours a week.

Consequences, all stemming from _a single machine in a house_:

- Missed-run catch-up is mandatory (FR-027). Candidate mechanism: a scheduler that persists and replays a missed window (e.g. a systemd timer with `Persistent=true`, or a startup check) — plain cron silently skips.
- External heartbeat is mandatory (FR-028).
- **Boot from SSD, not SD card.** SD cards corrupt under sustained write, and this database holds three days of in-flight work plus the full publishing archive. Back the DB up off-device.
- **Secrets** (Meta, LinkedIn, Canva, Anthropic) live on a device in a private home. Locked-down permissions on an environment file at minimum; never in the repo.
- Exposure is via Cloudflare Tunnel (see §2) — this is the "not exposed on the public internet" property in the PRD's Access Control.

**Candidate tools / vendors (routed out of PRD, product intent stated there instead):**

- **Rendered scraping tool** for sources without RSS/API — e.g. Firecrawl (FR-002 tier 3).
- **Visual generation via Canva** brand templates + autofill; operator owns the design directly in Canva's editor (FR-015). PRD states only the observable property: operator controls design, no code change to update it.
- **Per-run cost ceiling via the model SDK's budget parameter** (`maxBudgetUsd` / `maxCost`, SDK-dependent) (FR-016).
- **Scheduler with missed-run catch-up** (systemd timer `Persistent=true` or equivalent) (FR-027).

**Reused component:** the social publishing integration (Instagram, Facebook, LinkedIn) is carried over from a prior project for the same client and is already validated across all three platforms — not to be rebuilt.

---

## 11. Non-Goals

Explicitly **not** built:

- **Infographics as an output format — dropped permanently.** A good infographic is a design act, not a fill-in-the-blanks operation; only number-driven stories would autofill reliably. Dropping it means every v1 output flows through the same Canva template mechanism — one path instead of two.
- **Podcast / audio digest — parked as a fast-follow.** Technically viable (script + TTS), but Polish synthetic voice quality is uneven and audio can't be skimmed, so a weak script shows badly. Prove text and visual content first.
- **Multiple users, roles, or user management.**
- **Rebuilding the social publishing integration** — reused from the prior project, already validated across all three platforms.
- **Recency-based ranking.**
- **Fully autonomous publishing** — both human gates are permanent product features, not temporary scaffolding.

---

## 12. Cost & Model Strategy

Effort tiering runs throughout, matching model strength to task:

| Operation                      | Scope                       | Model tier |
| ------------------------------ | --------------------------- | ---------- |
| Clustering + relevance scoring | Whole pool, title+lede only | Cheap      |
| Shortlist translation          | Top 15, batched, one call   | Cheap      |
| Full translation + copywriting | Only the 2–4 selected       | Strong     |
| AI web search                  | Last resort only            | —          |

Bounded by the hard per-run ceiling (FR-016).

---

## 13. Open Questions

1. **Exact source list, and which sources expose RSS.** FR-002 is per-source; the tiering can't be configured until each source is classified.
2. **Canva API access.** Brand templates and autofill sit behind a paid tier and may require an access application. Confirm approval _early_ — this is a dependency with external lead time.
3. **Carousel length.** How many slides? Fixed, or driven by story count?
4. **Selection granularity.** When the operator picks a multi-source cluster, does he pick the cluster (agent chooses source material) or a specific article within it?
5. **Retention policy.** How long is full-fidelity archive material kept, given local disk?
6. **Notification channel.** Email is specified — is there value in a second channel (Telegram/push) for the Monday reminder specifically, given it's time-critical?
7. **Late-Sunday news.** The 17:00 scrape leaves a 7-hour gap at the end of the declared window. Shrink the window to Sunday 17:00, or roll late items into the next week?
8. **Podcast specifics** (deferred with the feature): Polish TTS provider, episode length, distribution target.
9. **Delivery timeline.** `mvp_weeks` is intentionally unset — the operator prioritizes reliability and quality of the delivered product over a fixed schedule, and this is a client deliverable rather than an after-hours build. Owner: operator. A rough milestone target (even a soft one) would help `/10x-roadmap` sequence slices; decide whether to leave this open or set a soft target once the stack is chosen.

---

## 14. Non-Functional Requirements

Externally observable properties the product must hold at its boundary:

- **Unattended reliability.** A scheduled weekly run either completes and notifies success, or its failure is made visible to the operator — silence never reads as "no news" (FR-028 heartbeat, FR-027 catch-up).
- **Numeric fidelity.** Published figures (prices, percentages, dates) match the source exactly; a mismatch blocks publication rather than shipping a wrong number (FR-014).
- **Bounded cost per run.** No single weekly run can exceed the configured spend ceiling, even under repeated model-output failures (FR-016).
- **Access resistance.** Guessing the PIN at scale is rejected before it can reach the publishing controls, while the single legitimate operator is not permanently locked out by ordinary mistypes (FR-022).
- **Correct-time publishing.** Scheduled publish fires at the intended wall-clock local time year-round, across the daylight-saving transition (named-zone `Europe/Warsaw`).
- **Human-in-the-loop guarantee.** Nothing reaches a public social account without explicit operator approval, in every path including missed deadlines (FR-020, FR-023).
- **Durability of in-flight state.** A run's state survives across the three-day Sunday→Tuesday window and a machine restart without losing the week's work.

---

## 15. Quality cross-check

Soft-gate result at finalization (`quality_check_status: warned` — one non-blocking gap, accepted):

| Check                                       | Status                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access control defined                      | present — single operator, PIN + lockout + Cloudflare Tunnel (§2)                                                                                                                                                                                                   |
| Business Logic (one-sentence rule)          | present — §7                                                                                                                                                                                                                                                        |
| Project artifacts / shape-notes frontmatter | present — checkpoint block + context_type                                                                                                                                                                                                                           |
| Timeline-cost acknowledged                  | **warned** — `mvp_weeks` deliberately left unbounded; operator explicitly chose reliability/quality over a fixed timeline (§3). Not a short-timeline ack and not a fabricated estimate; routed to Open Question #9 for a soft milestone target at the roadmap step. |
| Non-Goals                                   | present — §11                                                                                                                                                                                                                                                       |

`/10x-prd` will mirror the warned item into `## Open Questions` (already captured as #9).

---

## Appendix — Decisions Changed During Shaping

Recorded so the reasoning isn't lost:

| Original design                                  | Revised to                                        | Why                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| URL-based dedup                                  | Semantic clustering + coverage as ranking boost   | Same story across outlets was being shown 3× or silently discarded; multi-outlet coverage is a signal of importance |
| Title-only ranking                               | Title + lede                                      | Headlines are written to sell, not to inform                                                                        |
| Scrape-first collection                          | Per-source tiering: RSS → API → rendered scraping | Fragility and blocking, Idealista especially                                                                        |
| Rubric as untested prompt                        | Rubric + eval harness                             | The prompt carries the business logic; changing it blind risks silent regressions                                   |
| Picks discarded after run                        | Picks captured as labeled feedback                | ~100+ human judgments accumulate within months, for free                                                            |
| "Numbers preserved exactly" (prompt instruction) | Deterministic numeric assertion                   | A hope in a prompt is not a guarantee                                                                               |
| No cost ceiling                                  | Hard per-run cap                                  | Unattended retry loops bill quietly                                                                                 |
| Three formats (carousel / video / infographic)   | Post or carousel only                             | Infographic can't be reliably autofilled; single mechanism for all output                                           |
| Single-sitting run with live polling             | Three-day durable workflow                        | Sunday → Tuesday rhythm; operator is away from the screen for most of it                                            |
| Deadline behavior undefined                      | Skip + manual publish later                       | Undefined rules get invented by the agent and implemented consistently                                              |
| "5PM CET"                                        | `Europe/Warsaw` named zone                        | CET/CEST DST bug                                                                                                    |
