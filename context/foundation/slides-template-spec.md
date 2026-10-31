# Google Slides template spec

This is what the rendering stage expects your two template decks to look like. It is the **only**
contract between your design work and the code: the worker looks for placeholder *names* and, in
the carousel deck, the *tags* in each slide's speaker notes — never positions, colours or fonts.
You can restyle whenever you like without a deploy.

The machine-readable version lives in `src/lib/visuals/template.ts`. If the two ever disagree, that
file is right and this document is stale.

Check your decks at any time with:

```
npm run visuals:validate
```

---

## The two decks

| Deck | Page | What it's for |
| --- | --- | --- |
| **Carousel** | 1080 × 1350 px (4:5) | One weekly post: the cover, then one photo slide per picked story |
| **Single post** | 1080 × 1080 px (square) | One image per picked story (to be redesigned) |

Every slide the worker fills is a **copy**: it duplicates the slide, fills the copy, exports it and
deletes the copy. Your deck is left exactly as you designed it after every run.

---

## Carousel deck

### Tags — speaker notes

Every slide carries a tag in its **speaker notes** (View → Show speaker notes). Notes never appear in
the exported images.

| Tag | Meaning |
| --- | --- |
| `role=cover` | The weekly cover. Exactly **one** slide. Exported as designed — no placeholders. |
| `role=story section=barcelona` | A photo slide for Barcelona / Catalonia stories |
| `role=story section=spain` | A photo slide for Spain-wide (or EU/global) stories |
| `role=story section=finance_law` | A photo slide for prices, loans, taxes and law stories |

Order and capitalisation don't matter (`section=spain role=story` is fine). Slide order in the deck
doesn't matter either. Add, remove or reorder photo slides freely — each section needs at least one.

### How a week's carousel is built

1. The cover first.
2. Then one slide per picked story, in shortlist order.
3. Each story belongs to its **geography** section (Barcelona or Spain) and, when ranking flagged it
   as finance/law, also to `finance_law`. A story that fits two sections takes the one used least so
   far in this carousel; a tie goes to the geography section.
4. Within a section, photos rotate week by week and never repeat inside one carousel (unless a
   section has fewer photos than stories).

### Placeholders — story slides

One text box holding exactly two paragraphs, title first:

```
{{TITLE}}
{{DESCRIPTION}}
```

| Placeholder | Filled with |
| --- | --- |
| `{{TITLE}}` | The generated Polish headline |
| `{{DESCRIPTION}}` | The one-to-two-sentence caption summary |

Style each paragraph as you like (e.g. title bold 32 pt, description regular 22 pt). Make the box
as tall as the space the text may use — the worker sets font sizes, never moves or resizes the box.

**Why one box:** Slides switches off "resize shape to fit text" whenever the API replaces text, so a
headline in its own box that wraps onto a second line would run over a description below it. In one
box the description flows under however many lines the title takes.

**Font sizes:** the worker steps both paragraphs down through fixed sizes for long text. Past the
smallest size it stops the run and names the story and its character count, rather than publishing
text that overflows.

---

## Single-post deck

One slide with seven text boxes, one placeholder each:

| Placeholder | Filled with |
| --- | --- |
| `{{TITLE}}` | The generated Polish headline (auto-sized) |
| `{{STAT_1_LABEL}}` / `{{STAT_1_VALUE}}` | First statistic |
| `{{STAT_2_LABEL}}` / `{{STAT_2_VALUE}}` | Second statistic |
| `{{STAT_3_LABEL}}` / `{{STAT_3_VALUE}}` | Third statistic |

Size the `{{TITLE}}` box for roughly three lines at your largest size.

---

## Rules the validator enforces

Both decks:

- **No unrecognised `{{...}}` tokens.** A typo like `{{TITTLE}}` looks normal in the deck and only
  shows up printed across a finished card. → *fatal*
- **Each placeholder appears exactly once per slide.** → *fatal*

Carousel:

- Page is 4:5 → *fatal*; 4:5 but not 1080 px wide → *warning*
- Every slide has a valid tag; exactly one cover; every section has a usable story slide → *fatal*
- `{{TITLE}}` and `{{DESCRIPTION}}` share one box, title first, nothing else in it → *fatal*
- The cover holds no placeholders → *fatal*

Single post:

- Exactly 1 slide; each placeholder in its own text box → *fatal*
- Square page → *fatal*; square but not 1080 px → *warning*

Anything without a placeholder — logos, photos, shapes, the website and email lines — is ignored.

---

## Sharing

Both decks must be shared with the service account in `GOOGLE_SA_EMAIL` as **Editor** (the worker
duplicates and deletes slides). It holds only the `presentations` scope, so it cannot see anything
in your Drive you haven't shared with it. Undo any change through File → Version history.

Copy each presentation id (between `/d/` and `/edit` in the URL) into `SLIDES_DECK_CAROUSEL` and
`SLIDES_DECK_SINGLE_POST` in `.env`.
