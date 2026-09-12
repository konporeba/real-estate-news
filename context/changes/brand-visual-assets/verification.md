# S-06 live verification

Record of Phase 7: the rendering stage run against the real Google account, the operator's own
decks, and real generated copy. Written 2026-09-12.

## Setup

|                      |                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------- |
| Google Cloud project | `real-estate-news-508408`, Slides API enabled                                       |
| Service account      | `slides-renderer@real-estate-news-508408.iam.gserviceaccount.com`, **no IAM roles** |
| Scope held           | `https://www.googleapis.com/auth/presentations` only — no Drive scope               |
| Single-post deck     | `13Ow8Z-UQrSw4bkJHeleq42LNE7qG0v0TENO_St2aIac`, 1 slide                             |
| Carousel deck        | `1P2uDolDS_T64ytNHmxAjtysEWjbHGtBESaZ_gzmD5Tc`, 2 slides                            |
| Sharing              | both shared with the service account as **Editor**                                  |

`npm run visuals:validate` → exit 0, both decks conform.

The first service-account key was printed to a terminal during setup and was **revoked and
replaced** before either deck was shared with the account — at that moment the leaked key had
access to nothing, since the account holds no IAM roles and no document had been shared with it.

## Live smoke (7.1)

`SLIDES_LIVE_SMOKE=1 npx vitest run src/lib/visuals/slides.live.test.ts` — passed, 7.6s.

Proves what a fake transport cannot: the key authenticates, Editor access is real
(`duplicateObject` and `deleteObject` both succeed), `replaceAllText` genuinely substitutes (the
test re-reads the page and asserts the Polish title is present and `{{TITLE}}` is gone — a mistyped
placeholder makes the call a _successful no-op_), the export is real square PNG bytes, and the
template slide is byte-identical afterwards with no leftover `renderx*` page.

## Run 1 — digest `c92aa3c5`, first render (7.3)

`npm run visuals -- --digest=c92aa3c5-d565-4408-8a27-fb087948aaa9`

|                  |                                                          |
| ---------------- | -------------------------------------------------------- |
| Week             | 2026-08-31 → 2026-09-06                                  |
| Format           | `single_post`                                            |
| Stories          | 4                                                        |
| Assets           | 4, all 1600×1600 PNG, 97–107 KB                          |
| Retries          | none — every page rendered on its first attempt          |
| Final status     | `ready_for_approval`                                     |
| Decks afterwards | clean: 0 leftover pages, all placeholders intact in both |

The digest was in `ready_for_approval` (generation used to transition straight there, before this
slice), so it was moved `ready_for_approval → failed → rendering` via the entrypoint's own retry
path. That path is now exercised for real, not just in tests.

**Every slot filled correctly and no `{{TOKEN}}` survived**, but the cards were not publishable:
the title overflowed its box and printed across `{{STAT_1_LABEL}}`.

## Root cause, and why the fit tiers were NOT changed (7.2)

Measured the deck: **all seven placeholder boxes were Slides' untouched default text box, 236 × 32
pt on an 810 × 810 pt page** — 29% of the card's width, 4% of its height, one line at 14pt.

A 59-character Polish headline at 236pt wide wraps to five lines ≈ 200pt, into a box 32pt tall.
Slides does not clip, so it renders over whatever is beneath it.

**No tier change can fix that.** Even the smallest tier (26pt) still wraps to ~4 lines ≈ 110pt in a
32pt box; fitting one line would need roughly 6pt, unreadable at any size. The box is the binding
constraint, not the font size, and shrinking the ladder would have made the text tiny _and_ still
overlapping — a worse failure that looked like a deliberate choice.

`TITLE_SIZE_TIERS` is therefore **unchanged**. Re-measured after the deck was fixed: the longest
real title (68 chars) sets at 36pt and occupies 2 lines of a 220pt box, with headroom. The ladder is
calibrated correctly for a title box sized per `template-spec.md`; it stays exported so a future
deck with different proportions can retune it without touching a call site.

## Deck geometry change and re-render (7.5, US-13)

Resized the seven boxes in the single-post deck via the Slides API — **geometry only**, no fonts,
colours, alignment or content touched:

| Placeholder        | Box (pt)  | Position (pt)         |
| ------------------ | --------- | --------------------- |
| `{{TITLE}}`        | 690 × 220 | (60, 80)              |
| `{{STAT_n_LABEL}}` | 216 × 76  | (60 / 297 / 534, 400) |
| `{{STAT_n_VALUE}}` | 216 × 56  | (60 / 297 / 534, 484) |

The original transforms are saved in this session's scratchpad as `deck-transforms-before.json`;
reverting is one `updatePageElementTransform` batch.

Re-ran the identical command on the identical commit. Output changed — no overlap, the longest
title now sets on two lines, the three statistics align in a row. **That is US-13: a design change
took effect with no code change, no deploy, and no restart.**

## Operator verdict (7.4)

The operator reviewed the re-rendered cards and confirmed them publishable for now, and confirmed
the dashboard preview loads them behind the PIN gate.

**Known and accepted gap:** the decks are deliberately unstyled — default Arial, black on white, no
background, logo or brand colours. That is design work the operator owns and can do at any time; by
the argument above it requires no code change and no involvement from this stage. Worth revisiting
before S-08 actually publishes anything.

## Carousel deck

Not exercised by a full render — digest `c92aa3c5`'s selection is `single_post`. The carousel deck
passes the validator and its story slide still carries Slides' default 236 × 32 pt boxes, so it will
need the same geometry treatment before the first carousel week.
