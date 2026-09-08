# Google Slides template spec (S-06)

This is what the rendering stage expects your two template decks to look like. It is the **only**
contract between your design work and the code: the worker looks for placeholder *names* and
nothing else — not positions, not colours, not fonts, not the order of elements on the page. That
is what makes FR-015 true, and why you can restyle whenever you like without a deploy.

The machine-readable version of everything here lives in `src/lib/visuals/template.ts`. If the two
ever disagree, that file is right and this document is stale.

Check your decks at any time with:

```
npm run visuals:validate
```

---

## The two decks

| Deck | Slides | What it's for |
| --- | --- | --- |
| **Single post** | 1 | Rendered once per selected story (2–4 images per week) |
| **Carousel** | 2 | Slide 1 is the cover; slide 2 is a story template the worker duplicates once per story |

The carousel's second slide is a **template**, not a real slide. You design it once; the worker
copies it as many times as there are stories, fills each copy, exports it, and deletes the copies.
Your deck is left exactly as you designed it after every run.

---

## Page setup — both decks

**File → Page setup → Custom → 1080 × 1080 px**

Square is not a stylistic choice. One square asset is published to Instagram, LinkedIn and Facebook
alike, and all three render it correctly. Slides' default is 16:9, which would produce letterboxed
posts on every platform — so a non-square deck is a hard failure in the validator, not a warning.

A square deck of a different size (say 800 × 800) only warns: it still renders correctly, just at a
lower density.

---

## Placeholders

Type these as ordinary text, exactly as written, braces included. Case matters.

### Story slide — single-post deck slide 1, carousel deck slide 2

| Placeholder | Filled with |
| --- | --- |
| `{{TITLE}}` | The generated Polish headline |
| `{{STAT_1_LABEL}}` | First statistic's label |
| `{{STAT_1_VALUE}}` | First statistic's figure |
| `{{STAT_2_LABEL}}` | Second statistic's label |
| `{{STAT_2_VALUE}}` | Second statistic's figure |
| `{{STAT_3_LABEL}}` | Third statistic's label |
| `{{STAT_3_VALUE}}` | Third statistic's figure |

Exactly three statistics reach the card. Generation produces three to five; the first three are
used. Slides cannot hide an element, so a fourth pair of slots would render as an empty pill on
most weeks — which is why the count is fixed rather than variable.

### Cover slide — carousel deck slide 1 only

| Placeholder | Filled with |
| --- | --- |
| `{{COVER_TITLE}}` | The week's heading |
| `{{COVER_SUBTITLE}}` | The date range |

---

## Rules the validator enforces

1. **Each placeholder gets its own text box.** Not a cosmetic rule. The worker resizes the
   `{{TITLE}}` box to fit the headline, and it resizes the *whole box* — anything sharing it gets
   resized too, silently and wrongly. → *fatal*
2. **Each placeholder appears exactly once per slide.** Twice means the same text renders in two
   places; zero means a blank. → *fatal*
3. **No unrecognised `{{...}}` tokens.** A typo like `{{TITTLE}}` looks completely normal in the
   deck and only reveals itself as `{{TITTLE}}` printed across a finished card. This check is the
   main reason the validator exists. → *fatal*
4. **Exact slide count** — 1 for single post, 2 for carousel. → *fatal*
5. **Square page.** → *fatal*; wrong-but-square → *warning*

Anything not containing a placeholder — logos, background shapes, your standing byline, decorative
rules — is ignored entirely. Add as much as you like.

---

## About the title

Google Slides' "shrink text on overflow" **does not work through the API**. The moment the worker
replaces text, Slides resets autofit to `NONE` and restores the default font scale. This is
documented behaviour, not a bug we can work around from the deck side.

So the worker sizes the title itself, from a step-down table calibrated against real generated
headlines. What that means for you:

- **Size the `{{TITLE}}` box for the longest headline you'd accept**, not for the placeholder text.
  The worker changes the font size; it never moves or resizes the box.
- Give it room for roughly three lines at your largest size.
- A headline past the last tier fails the run with a readable diagnostic rather than rendering
  unreadably small.

Statistic slots are **not** auto-sized — they hold short figures like `4 250 €/m²`. Size them
normally.

---

## Sharing

Both decks must be shared with the service account address in `GOOGLE_SA_EMAIL` as **Editor**.

Editor, not Viewer: the worker duplicates and deletes slides inside your deck. It never creates,
renames or deletes Drive files, and it holds only the `presentations` scope — so this credential
cannot see anything in your Drive that you have not explicitly shared with it.

If you forget this step, `npm run visuals:validate` says so in as many words.

---

## Setting up from scratch

1. New Slides presentation → **File → Page setup → Custom → 1080 × 1080 px**
2. Design the story slide. Add seven text boxes containing the story placeholders.
3. For the carousel deck, add a second slide **before** it for the cover, with the two cover
   placeholders. Order matters: cover first, story template second.
4. Share with `GOOGLE_SA_EMAIL` as Editor.
5. Copy each presentation id (the part of the URL between `/d/` and `/edit`) into
   `SLIDES_DECK_SINGLE_POST` and `SLIDES_DECK_CAROUSEL` in `.env`.
6. `npm run visuals:validate` — fix anything it reports, then you're done.
