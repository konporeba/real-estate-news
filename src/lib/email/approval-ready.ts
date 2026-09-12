// WORKER-SIDE. FR-019's "content is ready for approval" notification — mirrors
// src/lib/email/digest-ready.ts's shape exactly, the second real caller of the F-04 email
// harness.
//
// A pure function on purpose: it takes the generated stories and returns an EmailRequest, so the
// mapping is testable without a transport and the worker keeps the only side effect.
import { escapeHtml, renderArticleCards, type ArticleCard } from "@/lib/email/layout";
import type { EmailRequest } from "@/lib/email/send";
import type { SourceTextOrigin } from "@/types";

/** The digest fields the notification names. */
export interface ApprovalReadySummary {
  id: string;
  window_start: string;
  window_end: string;
}

/** One generated story, as the rendering worker reads it back out of `generated_copy`. */
export interface ApprovalReadyItem {
  polishTitle: string;
  captionSummary: string;
  keyStatisticsCount: number;
  sourceTextOrigin: SourceTextOrigin;
}

function toCard(item: ApprovalReadyItem): ArticleCard {
  const stats = `${String(item.keyStatisticsCount)} statistic${item.keyStatisticsCount === 1 ? "" : "s"}`;
  // The lede-origin marker surfaces the same thing generate.ts's own operator summary does: a
  // short post is explained by its source, not mysterious.
  const meta = item.sourceTextOrigin === "lede" ? `${stats} · short source` : stats;

  return {
    title: item.polishTitle,
    description: item.captionSummary,
    meta,
  };
}

/**
 * Build the approval-ready notification.
 *
 * `baseUrl` is optional because DASHBOARD_BASE_URL is: an operator who has not yet configured the
 * tunnel hostname gets the generated stories in the email with no button, which is strictly
 * better than a button pointing nowhere. No image URLs are embedded here, deliberately: the
 * `digest-assets` bucket is private and signed URLs are short-lived, so nothing time-limited
 * belongs in a message that may be read days later — the CTA is the only link, and it always
 * resolves to something current.
 */
export function buildApprovalReadyEmail(
  digest: ApprovalReadySummary,
  items: ApprovalReadyItem[],
  baseUrl?: string,
): EmailRequest {
  const window = `${digest.window_start} – ${digest.window_end}`;
  const count = items.length;

  const intro =
    `<p style="margin: 0 0 20px;">${String(count)} ${count === 1 ? "story is" : "stories are"} generated and ` +
    `ready for approval for ${escapeHtml(window)}.</p>`;

  return {
    subject: `Content ready for approval: ${window}`,
    content: {
      heading: "This week's post is ready for approval",
      bodyHtml: intro + renderArticleCards(items.map(toCard)),
      cta: baseUrl
        ? { text: "Review and decide", url: `${baseUrl.replace(/\/+$/, "")}/dashboard/${digest.id}/approve` }
        : undefined,
    },
  };
}
