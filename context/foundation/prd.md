---
project: "Real Estate News"
version: 1
status: draft
created: 2026-07-20
context_type: greenfield
product_type: web-app
target_scale:
  users: small # single operator (the client)
  qps: low
  data_volume: small # weekly digests + archive on a single home machine
timeline_budget:
  mvp_weeks: null # deliberately unset — quality-first, not time-boxed (see Open Question #9)
  hard_deadline: null
  after_hours_only: false
---

# Spanish Real Estate News Digest — PRD

## Vision & Problem Statement

The client — a real estate professional serving Polish investors and expats in Spain, focused on Barcelona and Catalonia — publishes nothing on social media, despite an abundance of relevant Spanish real estate news each week. The obstacle is not material but time: the manual workflow (read Spanish sources, judge what matters to a Polish audience, translate, design a post, publish) is too expensive to sustain weekly, so it never happens. The cost today is a complete absence of social presence in a market where consistent, informed posting is a professional asset.

The insight that makes this worth building: the hard part is not the plumbing. The social publishing pipeline (Instagram, Facebook, LinkedIn) already exists and is validated from a prior project for the same client — everything _upstream_ of publishing is the gap. And the real product is an editorial judgment, not a scraper: a rule that ranks Spanish real estate stories by how geographically close they are to this audience (Barcelona/Catalonia first, Spain-wide-national next, global-with-Spanish-impact after) and whether they touch money or regulation. Automating that judgment — while keeping the human's two irreducible decisions (what to publish, and final approval) — turns zero posts a week into consistent posts a week at a cost of minutes, not hours.

## User & Persona

**Primary persona — the operator (the client).** A real estate professional whose audience is Polish investors and expats buying or renting property in Spain, with an editorial focus on Barcelona and Catalonia plus Spain-wide developments that affect the national property market. He reaches for this product once a week: he wants to maintain a credible, informed social presence but cannot afford the multi-hour manual workflow of finding, judging, translating, and designing posts. He is the only user. There is no secondary persona — the product is deliberately single-operator, with no roles, invitations, or user management.

## Success Criteria

### Primary

- The operator publishes a curated, Polish-language real estate digest **every week**, where before he published nothing.
- His weekly hands-on time is **minutes, not hours** — reduced to exactly two judgment decisions (which stories to publish, and final approval of the generated content); the system performs all gathering, ranking, translation, and design.

### Secondary

- The ranking converges over time on the operator's actual editorial taste (via captured picks-vs-passes), so selection gets easier week over week rather than staying a cold judgment call.
- A thin-news week still yields a usable shortlist rather than an empty digest.

### Guardrails

- **Nothing is ever published without the operator's explicit approval** — in every path, including a missed deadline. This is a permanent product property, not temporary scaffolding.
- **Published figures (prices, percentages, dates) exactly match their sources** — a mismatch blocks publication rather than shipping a wrong number.
- **No single weekly run exceeds its configured cost ceiling**, even under repeated malformed model output.
- **Scheduled publishing fires at the correct local wall-clock time year-round**, across the daylight-saving transition.
- **Brute-force access is resisted** before it can reach the publishing controls, while the single legitimate operator is not permanently locked out by ordinary mistypes.
- **In-flight weekly state survives** the multi-day run window and a machine restart without losing the week's work.

## User Stories

All stories are from the perspective of the single operator unless marked _(system)_ or _(developer)_.

### US-01: Weekly digest is prepared without me asking

- **Given** the collection window Monday–Sunday has closed
- **When** the scheduled Sunday evening run executes
- **Then** articles from all configured sources are collected, clustered, scored, and shortlisted
- **And** I receive an email telling me the digest is ready for selection

### US-02: A failed run doesn't cost me the week

- **Given** the Sunday run failed or the machine was offline
- **When** I open the dashboard and trigger the run manually
- **Then** collection executes against the same Monday–Sunday window
- **And** the digest proceeds as normal

### US-03: A blocked source doesn't break collection _(system)_

- **Given** one configured source fails to respond or blocks the request
- **When** collection runs
- **Then** the remaining sources are still collected
- **And** the failure is recorded against that source rather than failing the digest

### US-04: A thin week still produces a digest _(system)_

- **Given** primary sources yield fewer articles than the configured threshold
- **When** collection completes
- **Then** fallback sources are added
- **And** if the pool is still below the minimum, AI web search runs as a last resort

### US-05: I read the shortlist in Polish, with the Spanish original available

- **Given** the digest has reached `ready_for_selection`
- **When** I open the dashboard
- **Then** I see the top 15 stories with Polish titles and summaries
- **And** the original Spanish title and lede are shown alongside them, never discarded
- **And** each is marked with a flag indicating its language
- **And** I can decide in Polish while still checking the original wording

### US-06: The most relevant stories are at the top

- **Given** the week contained both Barcelona rental-price news and Madrid political news
- **When** I view the shortlist
- **Then** the Barcelona rental-price story ranks above the Madrid political story
- **And** ordering reflects relevance rather than publication time

### US-07: One story appears once

- **Given** the same story was covered by Idealista, Cinco Días, and El Economista
- **When** I view the shortlist
- **Then** I see a single entry annotated "covered by 3 sources"
- **And** that entry ranks higher than an equivalent story covered by one outlet
- **And** I can see the underlying sources if I want them

### US-08: I'm not misled by a headline _(system)_

- **Given** an article whose headline oversells its content
- **When** relevance is scored
- **Then** the score is computed from the title _and_ the lede/meta description
- **And** not from the headline alone

### US-09: I choose what gets published

- **Given** I am viewing the ranked shortlist
- **When** I select between 2 and 4 stories, choose a format (single post or carousel), and choose target platforms
- **Then** the digest moves to `generating`
- **And** only my selected stories receive the expensive full treatment

### US-10: My choices are remembered as signal _(system)_

- **Given** I selected 3 stories from a shortlist of 15
- **When** selection is confirmed
- **Then** both the 3 picks and the 12 passes are stored as labeled examples
- **And** they become available as few-shot material for future ranking

### US-11: Copy is written for social media, not translated literally

- **Given** my selected Spanish articles
- **When** generation runs
- **Then** I receive a compelling Polish title, a caption-ready summary, body copy suited to the chosen format, and pulled-out key statistics
- **And** the tone is adapted for social media rather than being a literal translation

### US-12: Numbers are never invented or drifted

- **Given** a source article containing prices and percentages
- **When** the generated Polish copy is produced
- **Then** every numeral extracted from the source is asserted present in the output
- **And** if any is missing or altered, the run fails rather than publishing wrong figures

### US-13: I control the design without touching code

- **Given** I have edited my brand template in the visual editor
- **When** the next digest generates visual output
- **Then** the new design is used
- **And** no code change or deployment was required

### US-14: Output is correctly sized per platform

- **Given** I selected Instagram and LinkedIn as targets
- **When** visual output is generated
- **Then** each platform's asset is produced from the template matching that platform's format

### US-15: A malfunctioning run cannot run up a bill _(system)_

- **Given** the model repeatedly returns malformed output and retries are triggered
- **When** the accumulated cost for the run reaches the configured ceiling
- **Then** the run halts
- **And** the failure is recorded for manual re-trigger

### US-16: Nothing publishes that I haven't seen

- **Given** generation has completed
- **When** the content is ready
- **Then** I receive an email notification
- **And** the digest waits in `ready_for_approval` until I explicitly approve it

### US-17: I'm reminded before the deadline, not after

- **Given** it is Monday and the digest is not yet approved
- **When** the reminder job runs
- **Then** I receive an email telling me which step is outstanding
- **And** I have a full day before the scheduled publish

### US-18: Approved content publishes on schedule

- **Given** the digest is approved
- **When** Tuesday 17:00 `Europe/Warsaw` arrives
- **Then** the content is published to each selected platform
- **And** per-platform success or failure is recorded independently with post IDs or error messages

### US-19: A missed deadline doesn't publish unapproved content

- **Given** Tuesday 17:00 arrives and I have not approved the digest
- **When** the scheduled publish job runs
- **Then** the publish is skipped
- **And** the digest remains available for me to publish manually from the dashboard at any later time

### US-20: One platform failing doesn't lose the others

- **Given** publishing succeeds on LinkedIn but fails on Instagram
- **When** the publish job completes
- **Then** the LinkedIn post remains live and recorded as successful
- **And** the Instagram failure is recorded with its error message

### US-21: I can see everything I've published

- **Given** previous digests have been published
- **When** I open the archive
- **Then** I can see, for each week, the shortlist I was shown, which stories I picked and passed, the generated copy, the visual output, the target platforms, and the per-platform result

### US-22: Only I can operate the system

- **Given** the dashboard is reachable only over a private path, not the public internet
- **When** someone enters an incorrect PIN 5 times
- **Then** further attempts are locked out and rate limited
- **And** access to the publishing controls is not obtainable by guessing

### US-23: Silence is never ambiguous _(system)_

- **Given** the home server is powered off or the scheduler has stalled
- **When** the expected heartbeat is not received
- **Then** an external monitor raises an alert
- **And** I learn that nothing ran, rather than assuming there was simply no news

### US-24: A missed schedule window is caught up _(system)_

- **Given** the machine was offline at the scheduled Sunday run time
- **When** it comes back online
- **Then** the scheduler detects the missed window and executes the run
- **And** the week is not silently lost

### US-25: Changing the rubric doesn't silently break it _(developer)_

- **Given** I have modified the relevance scoring rubric
- **When** I run the eval harness against the fixed set of known-correct examples
- **Then** I see whether scores drifted from expected values
- **And** I can catch a regression before the operator ever sees a bad shortlist

## Functional Requirements

### Collection

- FR-001: The system can collect articles published within the Monday–Sunday window from a configured source list. Priority: must-have
- FR-002: The system collects per-source using a tiered method rather than one global approach — a structured feed where the source offers one (preferred), a news API/aggregator second, and a rendered fetch only for sources that offer neither (some portals, e.g. Idealista, actively block automated fetching). Each source is configured with its own method. Priority: must-have
- FR-003: If the candidate pool is below a configured threshold, the system can add fallback sources; AI web search remains the last resort. Priority: must-have
- FR-018: The operator can manually re-trigger the collection run, so a failed Sunday run is recoverable without waiting seven days. Priority: must-have

### Ranking (the editorial brain)

- FR-004: The system semantically clusters candidate articles rather than deduplicating by URL — the same story across multiple outlets is one story with several sources. Priority: must-have
- FR-005: The system treats coverage count as a ranking boost — a story carried by more outlets ranks as more important, not more redundant. Priority: must-have
- FR-006: The system scores relevance from the title _and_ the lede/meta description, never the title alone. Priority: must-have
- FR-007: Each cluster receives a relevance score driven primarily by geography — Catalonia/Barcelona highest, then Spain-wide nationally-applicable matters (national mortgage rules, tax law, nationwide price/rental trends, Bank of Spain data), then global items with direct Spanish market impact (e.g. ECB rate decisions, EU-level property/residency regulation), with other regions' purely local news scored to be discarded. The rule separates _where a story was published_ from _where its effects land_ (a national announcement made in Madrid is national, not "Madrid news"). Topic refines the score: rental/purchase prices, mortgage rates, new construction, and regulatory change are boosted; unrelated local or purely political news sinks. Priority: must-have
- FR-008: The system ranks by relevance, not recency, and keeps the top 15 clusters. Priority: must-have
- FR-009: The system batch-translates the shortlist to Polish once; translation is idempotent and not repeated in later stages. Priority: must-have
- FR-009a: The system retains and displays both languages — the Polish translation alongside the original Spanish title/lede, each marked with a language flag — so the operator can read in Polish and fall back to the original to verify an odd translation. Priority: must-have

### Human gate 1 — selection

- FR-010: The system emails the operator on Sunday that the digest is ready for selection. Priority: must-have
- FR-011: The dashboard presents the ranked, translated shortlist, showing each multi-source story as a single entry annotated with its coverage count, with the underlying sources available as post material. Priority: must-have
- FR-012: The operator can select 2–4 stories, an output format (single post or carousel), and target platforms (Instagram, LinkedIn, Facebook). Priority: must-have

### Generation

- FR-013: The system gives only the selected stories full treatment — a complete Spanish→Polish adaptation for social media: compelling title, caption-ready summary, longer body copy for slides, and pulled-out key statistics. Priority: must-have
- FR-014: The system verifies numeric integrity deterministically, not via a prompt promise — numerals (prices, percentages, dates) are extracted from the source and asserted present in the output; failure fails the run. Priority: must-have
- FR-015: The system produces visual output from brand templates via named-slot autofill — the operator owns the design directly in a visual editor and the system fills the slots; one template per platform format; design changes require no code change or deployment. Priority: must-have
- FR-016: The system enforces a hard per-run cost ceiling and halts the run when accumulated cost reaches it. Priority: must-have
- FR-017: The system handles malformed model output with staged recovery plus bounded backoff retries, bounded by the FR-016 ceiling. Priority: must-have

### Human gate 2 — approval

- FR-019: The system emails the operator when generated content is ready for approval. Priority: must-have
- FR-020: The operator reviews the generated post and approves or rejects it before anything publishes. Priority: must-have
- FR-021: The system emails a Monday reminder if any step remains unvalidated. Priority: must-have

### Publishing

- FR-022: The system publishes approved content Tuesday 17:00 `Europe/Warsaw` to the selected platforms, tracking per-platform success/failure independently and recording post IDs or error messages. Priority: must-have
- FR-023: On a missed approval deadline, the system skips the scheduled publish, keeps the digest in an approved-and-pending state that the operator can publish manually later, and never publishes unapproved content. Priority: must-have

### Archive & learning

- FR-024: The system retains a full-fidelity archive of every digest — the shortlist presented, which stories were picked _and_ passed over, generated copy, visual output, target platforms, and per-platform results. Priority: must-have
- FR-025: The system captures each week's picks-vs-passes as labeled examples and feeds them back into the ranking rubric as few-shot material, so the rubric converges on the operator's actual taste. Priority: must-have
- FR-026: The system provides an eval harness for the ranking rubric — a fixed set of example articles with known-correct scores is run against the rubric before any rubric change ships. Priority: must-have

### Operations

- FR-027: The system uses a scheduling mechanism that catches up on missed runs — a run missed while the machine was off is executed on next start, rather than silently skipped. Priority: must-have
- FR-028: The system emits a periodic heartbeat to an external monitor (dead-man's-switch), so silence from the home server surfaces as an alert rather than being mistaken for "no news". Priority: must-have

## Non-Functional Requirements

- **Unattended reliability.** A scheduled weekly run either completes and notifies success, or its failure is made visible to the operator — silence never reads as "no news".
- **Numeric fidelity.** Published figures (prices, percentages, dates) match the source exactly; a mismatch blocks publication rather than shipping a wrong number.
- **Bounded cost per run.** No single weekly run can exceed the configured spend ceiling, even under repeated malformed model output.
- **Access resistance.** Guessing the PIN at scale is rejected before it can reach the publishing controls, while the single legitimate operator is not permanently locked out by ordinary mistypes.
- **Correct-time publishing.** Scheduled publish fires at the intended local wall-clock time (`Europe/Warsaw`) year-round, across the daylight-saving transition.
- **Human-in-the-loop guarantee.** Nothing reaches a public social account without explicit operator approval, in every path including a missed deadline.
- **Durability of in-flight state.** A run's state survives across the three-day Sunday→Tuesday window and a machine restart without losing the week's work.

## Business Logic

> **A story is worth publishing when it is geographically close to the audience (Barcelona/Catalonia > Spain-wide > global-with-Spanish-impact) and touches money or regulation — ranked by relevance rather than recency, reinforced by how many outlets carried it, and confirmed by the operator.**

The rule consumes, per candidate story, three user-facing inputs: the story's text (title and lede, not the headline alone), its geographic scope (distinguishing where it was _published_ from where its _effects_ land — a national announcement is national wherever it was made), and its topic (money and regulation — rental and purchase prices, mortgage rates, new construction, tax and regulatory change — are what this audience buys for). It also consumes a fourth input that grows over time: the operator's own past picks and passes, which teach the rule his actual editorial taste rather than a generic notion of newsworthiness.

The rule's output is a ranked shortlist: each distinct story (with duplicate coverage collapsed into a single entry whose breadth of coverage _raises_ its rank) carries a relevance score, ordered by relevance rather than by how recently it was published. The operator encounters this output as the top-15 shortlist on the dashboard, in Polish with the Spanish original alongside, and makes the final editorial call by selecting the 2–4 stories that will be published. The rule is versioned and regression-tested before any change ships, so its behavior is auditable and improvable rather than opaque — it is the product, not a generic scraper.

## Access Control

**Single operator; no roles, no multi-tenancy, no user management, no invitations.** One user (the client) operates the entire system.

The dashboard is reachable only over a private path, not exposed on the public internet. The operator authenticates with a **6-digit PIN**, protected by **lockout after roughly 5 failed attempts plus rate limiting** — a deliberate trade-off, since a 6-digit PIN alone is only ~10⁶ combinations and the system can post to real business social accounts; lockout and rate limiting make brute force impractical while keeping the sign-in as simple as the operator wants. There is no sign-up flow (the single operator is provisioned once) and no unauthenticated route to the publishing controls.

## Non-Goals

Explicitly **not** built for this MVP:

- **Infographics as an output format — dropped permanently.** A good infographic is a design act, not a fill-in-the-blanks operation; only number-driven stories would autofill reliably. Dropping it means every v1 output flows through the same template mechanism — one path instead of two.
- **Podcast / audio digest — parked as a fast-follow.** Technically viable (script + TTS), but Polish synthetic voice quality is uneven and audio can't be skimmed, so a weak script shows badly. Prove text and visual content first.
- **Multiple users, roles, or user management** — the product is single-operator by design.
- **Rebuilding the social publishing integration** — reused from the prior project, already validated across Instagram, Facebook, and LinkedIn.
- **Recency-based ranking** — ranking is by relevance, deliberately not by publication time.
- **Fully autonomous publishing** — both human gates (selection and approval) are permanent product features, not temporary scaffolding.

## Open Questions

1. **Exact source list, and which sources expose a structured feed.** FR-002 is per-source; the tiering can't be configured until each source is classified. — Owner: operator.
2. **Visual-template API access.** Brand templates and autofill (FR-015) sit behind a paid tier and may require an access application — confirm approval _early_, as it is a dependency with external lead time. — Owner: operator.
3. **Carousel length.** How many slides — fixed, or driven by story count? — Owner: operator.
4. **Selection granularity.** When the operator picks a multi-source cluster, does he pick the cluster (system chooses source material) or a specific article within it? — Owner: operator.
5. **Retention policy.** How long is full-fidelity archive material kept, given local disk? — Owner: operator.
6. **Notification channel.** Email is specified — is there value in a second channel (e.g. push) for the time-critical Monday reminder? — Owner: operator.
7. **Late-Sunday news.** The Sunday-17:00 collection leaves a ~7-hour gap at the end of the declared Monday–Sunday window — shrink the window to Sunday 17:00, or roll late items into the next week? — Owner: operator.
8. **Podcast specifics** (deferred with the feature): Polish TTS provider, episode length, distribution target. — Owner: operator; only if the fast-follow is picked up.
9. **Delivery timeline (`timeline_budget.mvp_weeks` is unset).** The operator prioritizes reliability and quality of the delivered product over a fixed schedule, and this is a client deliverable rather than an after-hours build, so no week count was set. A soft milestone target would help downstream roadmap sequencing — decide whether to leave this open or set a soft target once the stack is chosen. — Owner: operator. _(Mirrored from the shape-notes quality cross-check, recorded as a warned soft-gate item.)_
