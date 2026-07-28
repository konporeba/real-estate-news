// WORKER-SIDE. One reusable, Gmail-safe branded email shell. Every future notification (S-04's
// "digest ready", S-07's "content ready" and Monday reminder) renders through this so the design
// work happens once, here, rather than being redone per notification type.
//
// The palette and structure (gradient header banner, rounded card + shadow, bordered content
// box, gradient CTA button) intentionally mirror the client's other app (Real Estate AI Agent) so
// notifications from both products share a visual identity — same client, same look. The app name
// in the header/footer stays "Real Estate News" since it's a distinct product.
//
// Gmail strips <style> blocks in some rendering contexts (notably the Android app and clipped-
// message view), so every rule below is an inline `style` attribute — no shared <style> block —
// and structure uses nested <table> elements rather than CSS flexbox/grid.
const FONT_STACK = "'Segoe UI', Helvetica, Arial, sans-serif";

const HEADER_GRADIENT = "linear-gradient(135deg, #1e40af 0%, #2563eb 60%, #3b82f6 100%)";
const CTA_GRADIENT = "linear-gradient(135deg, #667eea, #764ba2)";

const PAGE_BG = "#f0f2f5";
const CARD_SHADOW = "0 4px 16px rgba(0, 0, 0, 0.10)";
const HEADING_COLOR = "#1a202c";
const BODY_COLOR = "#4a5568";
const MUTED_COLOR = "#a0aec0";
const CONTENT_BOX_BG = "#f7fafc";
const CONTENT_BOX_BORDER = "#e2e8f0";

export interface EmailContent {
  heading: string;
  bodyHtml: string;
  /** Plain-text body. When omitted, renderEmailText() derives one from heading + bodyHtml. */
  bodyText?: string;
  cta?: { text: string; url: string };
}

/**
 * A generic 3-level relevance indicator, deliberately not named after the ranking module's own
 * GeographyTier ("catalonia" | "national" | "global" | "discard") — this stays a rendering
 * primitive, decoupled from the digest schema. A future caller maps its real tier onto this scale
 * (e.g. catalonia -> "high", national -> "medium", global -> "low") and supplies the display text.
 */
export type ArticleScoreTier = "high" | "medium" | "low";

export interface ArticleScore {
  tier: ArticleScoreTier;
  /** Caller-supplied display text for the score pill, e.g. "Barcelona/Catalonia" or "94". */
  label: string;
}

/**
 * One item in a list of article cards (renderArticleCards). Deliberately generic — title, an
 * optional link, an optional short description/snippet, an optional one-line meta caption (e.g.
 * "3 sources"), and an optional color-coded relevance score — so this stays a rendering primitive
 * rather than coupling the harness to the digest schema. Callers map their own domain data
 * (article/cluster rows) into this shape. Cards are numbered automatically by list position; no
 * rank field needed.
 */
export interface ArticleCard {
  title: string;
  url?: string;
  description?: string;
  meta?: string;
  score?: ArticleScore;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ctaBlockHtml(cta: EmailContent["cta"]): string {
  if (!cta) return "";
  return `
            <tr>
              <td style="padding: 0 40px 40px; text-align: center;">
                <a href="${escapeHtml(cta.url)}"
                   style="display: inline-block; background: ${CTA_GRADIENT}; color: #ffffff; font-size: 14px; font-weight: 600; padding: 12px 36px; border-radius: 8px; text-decoration: none; letter-spacing: 0.3px; font-family: ${FONT_STACK};">
                  ${escapeHtml(cta.text)}
                </a>
              </td>
            </tr>`;
}

const META_PILL_BG = "#eef2ff";
const META_PILL_COLOR = "#4338ca";
const READ_LINK_COLOR = "#667eea";

/**
 * Reuses the client's other app's exact palette (its "Approve" green, its "Reminder" amber) for
 * high/medium so the two products' notifications read as the same visual language; low gets a
 * neutral slate rather than a "bad" color — a low-tier story is still worth showing, just least
 * prioritized.
 */
const SCORE_TIER_COLORS: Record<ArticleScoreTier, { accent: string; pillBg: string; pillColor: string }> = {
  high: { accent: "#16a34a", pillBg: "#dcfce7", pillColor: "#15803d" },
  medium: { accent: "#d97706", pillBg: "#fef3c7", pillColor: "#b45309" },
  low: { accent: "#64748b", pillBg: "#f1f5f9", pillColor: "#475569" },
};

function articleCardHtml(article: ArticleCard, position: number): string {
  const titleHtml = article.url
    ? `<a href="${escapeHtml(article.url)}" style="color: ${HEADING_COLOR}; text-decoration: none; font-weight: 600; font-size: 15px;">${escapeHtml(article.title)}</a>`
    : `<span style="color: ${HEADING_COLOR}; font-weight: 600; font-size: 15px;">${escapeHtml(article.title)}</span>`;

  const descriptionHtml = article.description
    ? `<p style="margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: ${BODY_COLOR}; font-family: ${FONT_STACK};">${escapeHtml(article.description)}</p>`
    : "";

  const scoreHtml = article.score
    ? `<span style="display: inline-block; background: ${SCORE_TIER_COLORS[article.score.tier].pillBg}; color: ${SCORE_TIER_COLORS[article.score.tier].pillColor}; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px; font-family: ${FONT_STACK};">${escapeHtml(article.score.label)}</span>`
    : "";

  const metaHtml = article.meta
    ? `<span style="display: inline-block; background: ${META_PILL_BG}; color: ${META_PILL_COLOR}; font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; font-family: ${FONT_STACK};">${escapeHtml(article.meta)}</span>`
    : "";

  const readLinkHtml = article.url
    ? `<a href="${escapeHtml(article.url)}" style="color: ${READ_LINK_COLOR}; font-size: 12px; font-weight: 600; text-decoration: none; font-family: ${FONT_STACK};">Read article &rarr;</a>`
    : "";

  const footerCells = [
    scoreHtml && `<td style="padding-right: 8px;">${scoreHtml}</td>`,
    metaHtml && `<td style="padding-right: 10px;">${metaHtml}</td>`,
    readLinkHtml && `<td>${readLinkHtml}</td>`,
  ].filter(Boolean);

  const footerHtml =
    footerCells.length > 0
      ? `
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top: 10px;">
              <tr>
                ${footerCells.join("")}
              </tr>
            </table>`
      : "";

  // A card without a score keeps the plain neutral border; a scored card gets a thicker,
  // tier-colored left edge so relevance is scannable down a long list at a glance.
  const border = article.score
    ? `border: 1px solid ${CONTENT_BOX_BORDER}; border-left: 4px solid ${SCORE_TIER_COLORS[article.score.tier].accent};`
    : `border: 1px solid ${CONTENT_BOX_BORDER};`;

  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #ffffff; ${border} border-radius: 8px; margin-bottom: 12px;">
        <tr>
          <td style="padding: 16px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td width="30" valign="top">
                  <table role="presentation" cellpadding="0" cellspacing="0">
                    <tr>
                      <td width="26" height="26" align="center" valign="middle" style="width: 26px; height: 26px; border-radius: 50%; background: ${CTA_GRADIENT};">
                        <span style="color: #ffffff; font-size: 12px; font-weight: 700; font-family: ${FONT_STACK};">${position}</span>
                      </td>
                    </tr>
                  </table>
                </td>
                <td style="padding-left: 12px;" valign="top">
                  ${titleHtml}
                  ${descriptionHtml}
                  ${footerHtml}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;
}

/**
 * Renders a list of article cards as an HTML fragment — bordered, rounded boxes with an
 * auto-numbered badge, linked title, optional description, and an optional meta pill + "read
 * article" link. Embed the result in EmailContent.bodyHtml; this does not render the surrounding
 * shell.
 */
export function renderArticleCards(articles: ArticleCard[]): string {
  return articles.map((article, index) => articleCardHtml(article, index + 1)).join("");
}

/** Renders content through the shared branded shell as self-contained, inline-styled HTML. */
export function renderEmailHtml(content: EmailContent): string {
  const heading = escapeHtml(content.heading);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>${heading}</title>
</head>
<body style="margin: 0; padding: 0; background: ${PAGE_BG}; font-family: ${FONT_STACK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: ${PAGE_BG}; padding: 40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: ${CARD_SHADOW};">
          <tr>
            <td style="background: ${HEADER_GRADIENT}; padding: 36px 40px; text-align: center;">
              <p style="color: #ffffff; margin: 0 0 4px; font-size: 26px; font-weight: 700; letter-spacing: -0.5px; font-family: ${FONT_STACK};">
                Real Estate News
              </p>
              <p style="color: #bfdbfe; margin: 0; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; font-family: ${FONT_STACK};">
                Weekly Digest
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 36px 40px 20px;">
              <h2 style="color: ${HEADING_COLOR}; margin: 0; font-size: 20px; font-weight: 600; font-family: ${FONT_STACK};">
                ${heading}
              </h2>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 40px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: ${CONTENT_BOX_BG}; border: 1px solid ${CONTENT_BOX_BORDER}; border-radius: 10px;">
                <tr>
                  <td style="padding: 20px; color: ${BODY_COLOR}; font-size: 15px; line-height: 1.7; font-family: ${FONT_STACK};">
                    ${content.bodyHtml}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${ctaBlockHtml(content.cta)}
          <tr>
            <td style="background: ${CONTENT_BOX_BG}; border-top: 1px solid ${CONTENT_BOX_BORDER}; padding: 20px 40px; text-align: center;">
              <p style="color: ${MUTED_COLOR}; margin: 0; font-size: 12px; line-height: 1.6; font-family: ${FONT_STACK};">
                Real Estate News &middot; Automated notification &mdash; do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Strips tags/collapses whitespace — a rough plain-text fallback, not an HTML parser. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Plain-text alternative for the same content. Returns `bodyText` verbatim when supplied. */
export function renderEmailText(content: EmailContent): string {
  if (content.bodyText !== undefined) return content.bodyText;

  const lines = [content.heading, "", stripHtml(content.bodyHtml)];
  if (content.cta) lines.push("", `${content.cta.text}: ${content.cta.url}`);
  return lines.join("\n");
}
