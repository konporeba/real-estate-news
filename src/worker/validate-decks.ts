// WORKER-SIDE ENTRYPOINT. `npm run visuals:validate` — a setup-time check on the operator's two
// Google Slides template decks, run before the rendering stage ever touches them.
//
// This exists because of what the alternative looks like. A placeholder typed `{{TITTLE}}` is
// invisible in the deck: it reads fine, it looks designed, and the first sign of trouble is a
// published-looking card with `{{TITTLE}}` printed across the middle of it, discovered at the
// approval gate on a Monday. Every check here converts that into a message on a Tuesday afternoon
// when the operator is already looking at the decks.
//
// Runs in plain Node, never in the Astro/workerd runtime. Nothing here (or anywhere under
// src/worker/ and src/lib/visuals/) may import astro:env/server or src/lib/supabase-admin;
// eslint.config.js enforces both directions of that boundary.
import { pathToFileURL } from "node:url";

import { createSlidesClient, type SlidesTransport } from "@/lib/visuals/slides-client";
import { type DeckKind, type DeckReport, isDeckValid, validateDeck } from "@/lib/visuals/template";
import { loadWorkerEnv } from "@/worker/env";

/** Thrown for an operator-facing refusal — printed without a stack trace. */
export class ValidateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidateRefused";
  }
}

export interface DeckTarget {
  kind: DeckKind;
  presentationId: string;
}

/**
 * Fetch and check every configured deck.
 *
 * A deck that cannot be READ is reported as a fatal problem rather than throwing, so one
 * unshared deck still lets the operator see what is wrong with the other. The single most likely
 * setup mistake — forgetting to share a deck with the service account — surfaces here as
 * `permission_denied`, and the message says exactly that.
 */
export async function validateDecks(slides: SlidesTransport, targets: DeckTarget[]): Promise<DeckReport[]> {
  const reports: DeckReport[] = [];

  for (const target of targets) {
    const presentation = await slides.getPresentation(target.presentationId);
    if (!presentation.ok) {
      const hint =
        presentation.reason === "permission_denied"
          ? " — share the deck with the service account as Editor"
          : presentation.reason === "not_found"
            ? " — check the presentation id in the Slides URL"
            : "";
      reports.push({
        kind: target.kind,
        presentationId: target.presentationId,
        problems: [{ fatal: true, message: `could not read the deck: ${presentation.reason}${hint}` }],
      });
      continue;
    }
    reports.push(validateDeck(target.kind, presentation.data));
  }

  return reports;
}

/** Human-readable rendering of one deck's result. */
export function formatReport(report: DeckReport): string {
  const header = `${report.kind} (${report.presentationId})`;
  if (report.problems.length === 0) return `  OK   ${header}`;

  const lines = report.problems.map((problem) => `         ${problem.fatal ? "error" : "warn "}  ${problem.message}`);
  return `  ${isDeckValid(report) ? "WARN" : "FAIL"} ${header}\n${lines.join("\n")}`;
}

export async function main(): Promise<number> {
  const env = loadWorkerEnv();

  if (!env.GOOGLE_SA_EMAIL || !env.GOOGLE_SA_PRIVATE_KEY_B64) {
    throw new ValidateRefused(
      "Google credentials are not configured. Set GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY_B64 in .env (see .env.example).",
    );
  }

  const targets: DeckTarget[] = [];
  if (env.SLIDES_DECK_SINGLE_POST) targets.push({ kind: "single_post", presentationId: env.SLIDES_DECK_SINGLE_POST });
  if (env.SLIDES_DECK_CAROUSEL) targets.push({ kind: "carousel", presentationId: env.SLIDES_DECK_CAROUSEL });

  if (targets.length === 0) {
    throw new ValidateRefused(
      "No template decks are configured. Set SLIDES_DECK_SINGLE_POST and SLIDES_DECK_CAROUSEL in .env — " +
        "the presentation id is the part of the Slides URL between /d/ and /edit.",
    );
  }

  const slides = createSlidesClient({
    serviceAccountEmail: env.GOOGLE_SA_EMAIL,
    privateKeyBase64: env.GOOGLE_SA_PRIVATE_KEY_B64,
  });
  if (!slides) {
    throw new ValidateRefused(
      "GOOGLE_SA_PRIVATE_KEY_B64 could not be decoded into a private key. It should be the base64 of either " +
        "the PEM key or the whole service-account JSON file.",
    );
  }

  const reports = await validateDecks(slides, targets);
  for (const report of reports) console.log(formatReport(report));

  const broken = reports.filter((report) => !isDeckValid(report));
  if (broken.length > 0) {
    console.error(
      `\n${String(broken.length)} deck(s) need fixing before the rendering stage can run. ` +
        "See context/changes/brand-visual-assets/template-spec.md.",
    );
    return 1;
  }

  console.log("\nAll configured decks conform to the template spec.");
  return 0;
}

// Only run when executed directly, so the tests can import the helpers above.
// pathToFileURL rather than string concatenation: Windows paths (X:\...) do not form a
// valid file:// URL by prefixing, and this project is developed on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof ValidateRefused) {
        console.error(error.message);
        process.exit(2);
      }
      console.error(error);
      process.exit(1);
    });
}
