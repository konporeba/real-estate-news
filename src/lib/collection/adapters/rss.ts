// Tier 1: structured feeds (FR-002's preferred method — stable, cheap, and the least
// likely to get us blocked). Covers RSS 2.0 and Atom via rss-parser.
import Parser from "rss-parser";
import { z } from "zod";

import type { Candidate, FetchAdapter } from "@/lib/collection/adapters/types";
import { MAX_ITEMS_PER_SOURCE } from "@/lib/collection/sources";

/** Per-source fetch budget. One hanging feed must not stall the whole run. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Identify ourselves honestly. FR-002 exists because these sources block automated
 * traffic; an anonymous scraper-looking agent from a home IP is how the RSS tier gets
 * lost too.
 */
const USER_AGENT = "RealEstateNewsDigest/0.1 (weekly digest bot; contact via site owner)";

// rss-parser's output is loosely typed and varies by feed dialect, so every item crosses
// into our types through a schema rather than a cast.
const feedItemSchema = z.object({
  link: z.string().optional(),
  guid: z.string().optional(),
  title: z.string().optional(),
  contentSnippet: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  isoDate: z.string().optional(),
  pubDate: z.string().optional(),
});

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { "User-Agent": USER_AGENT },
});

/** Strips tags and collapses whitespace — feed summaries routinely carry HTML. */
export function toPlainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Normalizes one parsed feed item, or null when it cannot be an article.
 *
 * A missing or unparseable date yields `publishedAt: null` rather than a dropped item:
 * feeds list recent content, and silently discarding undated items loses stories the
 * operator would have wanted. MAX_ITEMS_PER_SOURCE is what bounds the damage if a feed
 * turns out to carry undated evergreen content.
 */
export function normalizeItem(raw: unknown): Candidate | null {
  const parsed = feedItemSchema.safeParse(raw);
  if (!parsed.success) return null;

  const item = parsed.data;
  const sourceUrl = item.link?.trim() ?? item.guid?.trim();
  const title = item.title ? toPlainText(item.title) : "";
  if (!sourceUrl || !title) return null;

  const ledeSource = item.contentSnippet ?? item.summary ?? item.content;
  const lede = ledeSource ? toPlainText(ledeSource) : "";

  return {
    sourceUrl,
    title,
    lede: lede.length > 0 ? lede : null,
    publishedAt: parseDate(item.isoDate ?? item.pubDate),
  };
}

/** Parses already-fetched feed XML. Split out so tests can run against fixtures offline. */
export async function parseFeed(xml: string): Promise<Candidate[]> {
  const feed = await parser.parseString(xml);
  return feed.items
    .slice(0, MAX_ITEMS_PER_SOURCE)
    .map((item) => normalizeItem(item))
    .filter((candidate): candidate is Candidate => candidate !== null);
}

export const rssAdapter: FetchAdapter = async (source) => {
  const feed = await parser.parseURL(source.url);
  return feed.items
    .slice(0, MAX_ITEMS_PER_SOURCE)
    .map((item) => normalizeItem(item))
    .filter((candidate): candidate is Candidate => candidate !== null);
};
