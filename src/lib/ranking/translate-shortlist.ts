// WORKER-SIDE. Translates each shortlisted cluster's representative article (title + lede) to
// Polish through F-03's invoke(), in one batched call. Mirrors score-clusters.ts's echo-real-id
// batch pattern, not cluster.ts's localized-index trick — the id set here is at most
// SHORTLIST_SIZE, so a real UUID per item costs nothing meaningful.
import { z } from "zod";

import type { LlmTransport } from "@/lib/llm/client";
import { invoke } from "@/lib/llm/invoke";
import { DEFAULT_MODEL } from "@/lib/llm/pricing";
import type { ServiceClient } from "@/lib/supabase-service";
import type { LlmResult } from "@/types";

/** Output-token budget per article in the batch, plus a fixed floor — a translation is short. */
const MAX_TOKENS_PER_ARTICLE = 300;
const MAX_TOKENS_FLOOR = 400;

/** One shortlisted cluster's representative article, as translation sees it. */
export interface TranslatableArticle {
  id: string;
  title: string;
  lede: string | null;
}

export interface Translation {
  polishTitle: string;
  polishSummary: string | null;
}

const translatedItemSchema = z.object({
  articleId: z.string(),
  polishTitle: z.string(),
  polishSummary: z.string().nullable(),
});
const translationBatchSchema = z.object({ translations: z.array(translatedItemSchema) });

const TRANSLATION_SYSTEM = `You translate Spanish and Catalan real-estate news into Polish for a Polish-speaking audience.

For each article you are given a title and, optionally, a short lede. Translate the title faithfully into natural, editorial Polish — not a word-for-word gloss. If a lede is given, translate it faithfully too: do not shorten, expand, or add information beyond what the original says. If no lede is given, return null for the summary rather than inventing one.

Echo each article's id exactly as given.`;

function buildTranslationPrompt(articles: TranslatableArticle[]): string {
  const blocks = articles.map((a) => `[articleId: ${a.id}]\n${a.title}${a.lede ? `\n${a.lede}` : ""}`);
  return `Translate each of the following ${articles.length} articles to Polish. Return one translation object per article, echoing its articleId exactly.\n\n${blocks.join("\n\n")}`;
}

/**
 * Translate the shortlist's representative articles to Polish in one batched invoke() call — at
 * most SHORTLIST_SIZE items, so this doesn't need scoreClusters' chunking/concurrency, which
 * exists for pools of hundreds of clusters. A response that omits a requested article id is
 * malformed_output: a silently dropped translation would leave the dashboard falling back to the
 * original-language text for that story with no diagnostic.
 */
export async function translateShortlist(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  articles: TranslatableArticle[],
  options: { ceilingUsd: number },
): Promise<LlmResult<Map<string, Translation>>> {
  if (articles.length === 0) return { ok: true, data: new Map() };

  const result = await invoke(
    llm,
    db,
    digestId,
    {
      model: DEFAULT_MODEL,
      system: TRANSLATION_SYSTEM,
      messages: [{ role: "user", content: buildTranslationPrompt(articles) }],
      maxTokens: articles.length * MAX_TOKENS_PER_ARTICLE + MAX_TOKENS_FLOOR,
      schema: translationBatchSchema,
    },
    options,
  );
  if (!result.ok) return result;

  const translations = new Map<string, Translation>();
  for (const item of result.data.parsed.translations) {
    translations.set(item.articleId, { polishTitle: item.polishTitle, polishSummary: item.polishSummary });
  }

  const missing = articles.filter((a) => !translations.has(a.id)).map((a) => a.id);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "malformed_output",
      message: `translation omitted ${missing.length} article(s): ${missing.join(", ")}`,
    };
  }

  return { ok: true, data: translations };
}
