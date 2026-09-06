// WORKER-SIDE. Fetch a selected story's page and extract its readable body, so generation has
// real source material instead of a two-sentence lede.
//
// Why this exists: `article` stores only `original_title` and `original_lede`, and the live pool
// measures a MEDIAN lede of 184 characters. FR-013 asks for slide-length body copy and pulled-out
// key statistics — neither is reachable from two sentences without the model inventing material,
// which is exactly what FR-014's gate exists to catch. Only the 2-4 selected stories are fetched,
// once a week, so the cost of doing this properly is negligible.
//
// Why extraction quality is a CORRECTNESS concern, not a nicety: whatever text this module
// returns becomes the numeric gate's source of truth. A leaked "© 2024" or a phone number from a
// cookie banner becomes a figure the Polish copy is then REQUIRED to contain, and the run fails
// on a good translation. That is why this uses Readability — the algorithm behind Firefox Reader
// Mode — rather than a hand-rolled tag stripper, and why it pre-strips known boilerplate
// containers that Readability alone keeps (verified: a `class="cookie"` banner survives its
// parse).
//
// Never throws. Every failure is a typed reason the caller maps onto the lede-only fallback.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

import { toPlainText } from "@/lib/collection/adapters/rss";

/**
 * Why source text could not be obtained.
 *
 * - `blocked` — the source refused us (401/403/429). Idealista is enabled and known to do this.
 * - `not_found` — 404 or 410; the URL is gone.
 * - `network` — DNS, TLS, timeout, or any other non-2xx.
 * - `unparseable` — fetched fine, but Readability found no article (unusual layouts, JS-only
 *   pages, or an interstitial).
 * - `too_short` — parsed, but the result is shorter than a real article; almost always a paywall
 *   teaser or a consent interstitial rather than content.
 */
export type SourceTextFailure = "blocked" | "not_found" | "network" | "unparseable" | "too_short";

export type SourceTextResult = { ok: true; text: string; origin: "article" } | { ok: false; reason: SourceTextFailure };

/**
 * Below this, what came back is not an article. A paywall teaser or a cookie interstitial parses
 * cleanly and yields a few hundred characters — generating from that would be worse than the
 * stored lede, because it reads like content while carrying none.
 */
export const MIN_ARTICLE_CHARS = 600;

/** One page must not stall a weekly run. Matches the RSS tier's per-source budget in spirit. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Identify ourselves honestly — the same agent string the RSS tier uses.
 *
 * `src/lib/collection/sources.ts` records that a source returning 403 to us is "deliberately NOT
 * worked around by spoofing a browser" User-Agent. That policy applies here too: a source that
 * refuses this fetch takes the lede fallback, it does not get evaded.
 */
const USER_AGENT = "RealEstateNewsDigest/0.1 (weekly digest bot; contact via site owner)";

/**
 * Containers Readability keeps but an article does not want. Verified against its own output: a
 * cookie banner survives the parse and lands in `textContent`, taking its phone numbers with it.
 */
const BOILERPLATE_SELECTOR = "script, style, noscript, iframe, form";
const BOILERPLATE_ATTR = /cookie|consent|newsletter|subscri|paywall|banner|advert|promo|related|share/i;

/**
 * Turn a fetched HTML page into article text. Pure — no network — so the extraction rules are
 * testable against fixtures.
 */
export function extractArticleText(html: string): SourceTextResult {
  let text: string;
  try {
    const { document } = parseHTML(html);

    for (const element of document.querySelectorAll(BOILERPLATE_SELECTOR)) {
      element.remove();
    }
    // Class/id sweep for the containers Readability scores as content but a reader would not.
    for (const element of document.querySelectorAll("[class], [id]")) {
      const marker = `${element.getAttribute("class") ?? ""} ${element.getAttribute("id") ?? ""}`;
      if (BOILERPLATE_ATTR.test(marker)) element.remove();
    }

    const article = new Readability(document).parse();
    if (!article?.textContent) return { ok: false, reason: "unparseable" };

    // toPlainText only tidies entities and collapses whitespace here — Readability has already
    // done the structural work. It is never the extractor.
    text = toPlainText(article.textContent);
  } catch {
    // Malformed markup can throw inside the parser; that is an unparseable page, not a crash.
    return { ok: false, reason: "unparseable" };
  }

  if (text.length < MIN_ARTICLE_CHARS) return { ok: false, reason: "too_short" };
  return { ok: true, text, origin: "article" };
}

/** Map a non-2xx response onto the failure taxonomy. */
function statusFailure(status: number): SourceTextFailure {
  if (status === 401 || status === 403 || status === 429) return "blocked";
  if (status === 404 || status === 410) return "not_found";
  return "network";
}

export interface FetchArticleOptions {
  timeoutMs?: number;
  /** Injectable for tests, mirroring how the LLM and email harnesses take a transport. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch `url` and extract its article text, or say precisely why it could not be done.
 *
 * Never throws: a weekly unattended run must not die because one source changed its TLS config.
 */
export async function fetchArticleText(url: string, options: FetchArticleOptions = {}): Promise<SourceTextResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  let html: string;
  try {
    const response = await doFetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!response.ok) return { ok: false, reason: statusFailure(response.status) };
    html = await response.text();
  } catch {
    // AbortSignal.timeout rejects with a TimeoutError; DNS/TLS failures reject too. Both are
    // "we could not get the page", which is the same decision for the caller.
    return { ok: false, reason: "network" };
  }

  return extractArticleText(html);
}
