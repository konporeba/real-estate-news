// WORKER-SIDE ENTRYPOINT. `npm run visuals:preview` — fill every slide of the carousel template
// deck with sample stories and save the PNGs locally, so the operator sees what each photo slide
// looks like with real-length Polish text before a week's run does it for real.
//
// Side-effect free outside the deck itself: no database, no Storage, no digest. In the deck it
// does exactly what the rendering stage does — duplicate, fill, export, delete, through the same
// `exportPage` — so what it shows is what a run would publish. Pages are prefixed like the stage's,
// so a crash leaves nothing the next `npm run visuals` sweep would not collect.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fitCarouselText } from "@/lib/digest/fit";
import { type CarouselStoryPagePlan, exportPage, type PagePlan, RENDER_PAGE_PREFIX } from "@/lib/visuals/render";
import { createSlidesClient, type SlidesTransport } from "@/lib/visuals/slides-client";
import { pngDimensions } from "@/lib/visuals/store";
import { readCarouselDeck } from "@/lib/visuals/template";
import { loadWorkerEnv } from "@/worker/env";

/** Thrown for an operator-facing refusal — printed without a stack trace. */
export class PreviewRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewRefused";
  }
}

/** Where the PNGs land, relative to the working directory. Gitignored. */
export const PREVIEW_DIR = "visuals-preview";

/**
 * Sample copy, cycled across the photo slides. The long one sits near what the smallest fit tier
 * accepts, so the preview shows the worst case a real week can produce, not just the happy one.
 */
export const PREVIEW_SAMPLES: readonly { name: string; title: string; description: string }[] = [
  {
    name: "short",
    title: "Ceny mieszkań w Hiszpanii rosną o 12,1%",
    description: "Według INE średnia cena za m² osiągnęła 2 250 €.",
  },
  {
    name: "typical",
    title: "Euribor spada do 2,1% – raty kredytów hipotecznych w Hiszpanii będą niższe nawet o 60 € miesięcznie",
    description:
      "Dla kredytu 200 000 € na 25 lat oznacza to oszczędność około 720 € rocznie przy następnej aktualizacji oprocentowania.",
  },
  {
    name: "long",
    title:
      "Barcelona wprowadza limit czynszów dla 140 tys. mieszkań w 12 dzielnicach, a właściciele przekraczający indeks zapłacą kary",
    description:
      "Nowe przepisy wchodzą w życie od stycznia 2027 roku i obejmą umowy zawierane po tej dacie. Generalitat szacuje, że " +
      "średni czynsz spadnie o 6,4%, a kary dla właścicieli, którzy przekroczą indeks referencyjny, wyniosą od 3 000 € do " +
      "90 000 € w zależności od skali naruszenia i liczby lokali.",
  },
];

export interface PreviewPage {
  file: string;
  width: number;
  height: number;
}

export interface PreviewOutcome {
  pages: PreviewPage[];
  failures: string[];
}

/**
 * Plan one page per slide: the cover as designed, then every photo slide in deck order with the
 * samples cycled across them. Throws PreviewRefused when the deck does not pass the template spec
 * — the validator says what to fix.
 */
export function planPreview(slides: Parameters<typeof readCarouselDeck>[0]): { plans: PagePlan[]; names: string[] } {
  const deck = readCarouselDeck(slides);
  const fatal = deck.problems.find((problem) => problem.fatal);
  if (fatal || !deck.cover) {
    throw new PreviewRefused(
      `the carousel deck does not match the template spec (${fatal?.message ?? "no cover"}); run \`npm run visuals:validate\``,
    );
  }

  const plans: PagePlan[] = [{ kind: "cover", slideIndex: 0, clusterId: null, templatePageId: deck.cover.objectId }];
  const names = ["00-cover"];

  for (const [index, story] of deck.stories.entries()) {
    const sample = PREVIEW_SAMPLES[index % PREVIEW_SAMPLES.length];
    const size = fitCarouselText(sample.title, sample.description);
    if (!size.ok) throw new Error(`preview sample "${sample.name}" does not fit: ${size.message}`);

    const plan: CarouselStoryPagePlan = {
      kind: "carousel_story",
      slideIndex: index + 1,
      clusterId: `preview-${String(index + 1)}`,
      section: story.section,
      templatePageId: story.slide.objectId,
      templateBoxElementId: story.boxElementId,
      titleOffset: story.titleOffset,
      descriptionOffset: story.descriptionOffset,
      title: sample.title,
      description: sample.description,
      titlePointSize: size.data.titlePt,
      descriptionPointSize: size.data.descriptionPt,
    };
    plans.push(plan);
    names.push(`${String(index + 1).padStart(2, "0")}-${story.section}-${sample.name}`);
  }

  return { plans, names };
}

/** Render every planned page to `outDir`. One page failing does not stop the others. */
export async function renderPreview(
  slides: SlidesTransport,
  deckId: string,
  outDir: string,
  write: (path: string, bytes: Uint8Array) => void = (path, bytes) => {
    writeFileSync(path, bytes);
  },
): Promise<PreviewOutcome> {
  const presentation = await slides.getPresentation(deckId);
  if (!presentation.ok) {
    throw new PreviewRefused(`could not read the carousel deck: ${presentation.reason}: ${presentation.message}`);
  }

  // A previous crash's pages would otherwise be read as part of the operator's deck.
  const own = presentation.data.slides.filter((slide) => !slide.objectId.startsWith(RENDER_PAGE_PREFIX));
  const { plans, names } = planPreview(own);

  const created = new Set<string>();
  const outcome: PreviewOutcome = { pages: [], failures: [] };
  try {
    for (const [index, plan] of plans.entries()) {
      const exported = await exportPage(slides, deckId, plan, created);
      const dimensions = exported.ok ? pngDimensions(exported.data) : null;
      if (!exported.ok || !dimensions) {
        outcome.failures.push(`${names[index]}: ${exported.ok ? "the export was not a PNG" : exported.message}`);
        continue;
      }
      const file = join(outDir, `${names[index]}.png`);
      write(file, exported.data);
      outcome.pages.push({ file, ...dimensions });
    }
  } finally {
    // Best effort, as in the stage: anything left is prefixed and swept by the next run.
    for (const pageId of created) await slides.batchUpdate(deckId, [{ deleteObject: { objectId: pageId } }]);
  }
  return outcome;
}

export async function main(): Promise<number> {
  const env = loadWorkerEnv();
  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY_B64) {
    throw new PreviewRefused(
      "Google credentials are not configured. Set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY_B64 in .env (see .env.example).",
    );
  }
  if (!env.SLIDES_DECK_CAROUSEL) {
    throw new PreviewRefused("SLIDES_DECK_CAROUSEL is not set in .env; there is no carousel deck to preview.");
  }

  const slides = createSlidesClient({
    serviceAccountEmail: env.GOOGLE_SA_EMAIL,
    privateKeyBase64: env.GOOGLE_SA_PRIVATE_KEY_B64,
  });
  if (!slides) {
    throw new PreviewRefused("GOOGLE_SA_PRIVATE_KEY_B64 could not be decoded into a private key.");
  }

  mkdirSync(PREVIEW_DIR, { recursive: true });
  const outcome = await renderPreview(slides, env.SLIDES_DECK_CAROUSEL, PREVIEW_DIR);

  for (const page of outcome.pages) {
    console.log(`  ${page.file}  ${String(page.width)} x ${String(page.height)}`);
  }
  for (const failure of outcome.failures) console.error(`  FAILED ${failure}`);
  console.log(`\n${String(outcome.pages.length)} slide(s) written to ${PREVIEW_DIR}/`);
  return outcome.failures.length > 0 ? 1 : 0;
}

// Only run when executed directly, so the tests can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof PreviewRefused) {
        console.error(error.message);
        process.exit(2);
      }
      console.error(error);
      process.exit(1);
    });
}
