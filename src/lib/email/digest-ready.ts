// WORKER-SIDE. FR-010's "the digest is ready for selection" notification — the first real caller
// of the F-04 email harness.
//
// A pure function on purpose: it takes the shortlist and returns an EmailRequest, so the mapping
// is testable without a transport and the worker keeps the only side effect. `renderArticleCards`
// exists precisely for this message (F-04 added it once the operator asked for per-article
// visibility in the digest email), so the whole body is that primitive plus one line of context.
import { escapeHtml, renderArticleCards, type ArticleCard, type ArticleScoreTier } from "@/lib/email/layout";
import type { EmailRequest } from "@/lib/email/send";

/** The digest fields the notification names. */
export interface DigestReadySummary {
  id: string;
  window_start: string;
  window_end: string;
}

/** One shortlisted story, as the ranking worker reads it back out of the database. */
export interface DigestReadyItem {
  rank: number;
  tier: string | null;
  coverageCount: number;
  polishTitle: string | null;
  polishSummary: string | null;
  originalTitle: string;
  originalLede: string | null;
  sourceUrl: string | null;
}

/**
 * The geography rubric's tiers mapped onto the card primitive's deliberately generic
 * high/medium/low scale — `ArticleScoreTier` documents this as the caller's job, so the email
 * layout stays decoupled from the ranking schema.
 */
const TIER_SCORES: Record<string, { tier: ArticleScoreTier; label: string }> = {
  catalonia: { tier: "high", label: "Catalonia" },
  national: { tier: "medium", label: "National" },
  global: { tier: "low", label: "Global" },
  discard: { tier: "low", label: "Low" },
};

/**
 * A tier that isn't in the rubric's vocabulary degrades to `low` carrying its own name, rather
 * than throwing an unattended weekly run into a crash over a cosmetic pill.
 *
 * A NULL tier renders no pill at all. Showing "low" for a story that was never scored would be a
 * claim the data does not support, and this email is read at the moment the operator decides what
 * to publish.
 */
function toScore(tier: string | null): ArticleCard["score"] {
  if (!tier) return undefined;
  return TIER_SCORES[tier] ?? { tier: "low", label: tier };
}

function toCard(item: DigestReadyItem): ArticleCard {
  return {
    // Cards are auto-numbered by list position, and the shortlist arrives in rank order, so the
    // badge already reads as the rank — no rank field needed.
    title: item.polishTitle ?? item.originalTitle,
    url: item.sourceUrl ?? undefined,
    description: item.polishSummary ?? item.originalLede ?? undefined,
    meta: `${String(item.coverageCount)} source${item.coverageCount === 1 ? "" : "s"}`,
    score: toScore(item.tier),
  };
}

/**
 * Build the digest-ready notification.
 *
 * `baseUrl` is optional because DASHBOARD_BASE_URL is: an operator who has not yet configured the
 * tunnel hostname gets the shortlist in the email with no button, which is strictly better than a
 * button pointing nowhere.
 */
export function buildDigestReadyEmail(
  digest: DigestReadySummary,
  items: DigestReadyItem[],
  baseUrl?: string,
): EmailRequest {
  const window = `${digest.window_start} – ${digest.window_end}`;
  const count = items.length;

  const intro =
    `<p style="margin: 0 0 20px;">${String(count)} ${count === 1 ? "story is" : "stories are"} ranked and ` +
    `translated for ${escapeHtml(window)}. Pick 2–4 to publish.</p>`;

  return {
    subject: `Digest ready for selection: ${window}`,
    content: {
      heading: "This week's digest is ready",
      bodyHtml: intro + renderArticleCards(items.map(toCard)),
      cta: baseUrl
        ? { text: "Open the shortlist", url: `${baseUrl.replace(/\/+$/, "")}/dashboard/${digest.id}` }
        : undefined,
    },
  };
}
