// WORKER-SIDE. Groups the flat article pool into clusters of same-story articles (FR-004) — the
// input the scorer (Phase 2) and the ranker (Phase 4) consume. A cluster is one story; an article
// covered by only one outlet is a cluster of one.
//
// Single-pass: the whole pool (~234 articles × ~75 tokens ≈ 17k tokens of title+lede) fits Sonnet's
// context comfortably, so this is one invoke() call, not a batched loop like scoring.
import { z } from "zod";

import type { LlmTransport } from "@/lib/llm/client";
import { invoke } from "@/lib/llm/invoke";
import { DEFAULT_MODEL } from "@/lib/llm/pricing";
import type { ServiceClient } from "@/lib/supabase-service";
import type { LlmResult } from "@/types";

/** One article as clustering sees it: enough to judge same-story, nothing more. */
export interface ClusterableArticle {
  id: string;
  title: string;
  lede: string | null;
}

/** One story: the article ids that tell it. */
export interface ArticleCluster {
  articleIds: string[];
}

const groupingSchema = z.object({
  clusters: z.array(z.object({ articleIds: z.array(z.string()) })),
});

const CLUSTERING_SYSTEM = `You group news articles into stories. Each group of article ids you return is ONE story — the same real-world event or announcement, even if covered by several outlets with different headlines. An article that is its own story (no other outlet covered it) is a group of one.

Group by SAME STORY, not by topic or theme. Two articles about different mortgage-rate news are two stories, not one, even though both are about mortgages.

Every article id given to you must appear in exactly one group — every id is used once, and no id is invented.`;

function buildClusteringPrompt(articles: ClusterableArticle[]): string {
  const lines = articles.map((a) => `[id: ${a.id}] ${a.title}${a.lede ? `\n  ${a.lede}` : ""}`);
  return `Group these ${articles.length} articles into stories. Every article id must appear in exactly one group.\n\n${lines.join("\n\n")}`;
}

/**
 * Cluster the pool into stories via a single invoke() call. Validates the returned grouping is a
 * true partition of the input ids — no article dropped, none duplicated, none invented — because a
 * silently incomplete partition would lose or double-count articles in the ranking that follows.
 * A malformed partition returns `malformed_output`, since invoke()'s own reprompt validates the
 * schema shape but cannot know the input id set.
 */
export async function clusterArticles(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  articles: ClusterableArticle[],
  options: { ceilingUsd: number },
): Promise<LlmResult<ArticleCluster[]>> {
  if (articles.length === 0) return { ok: true, data: [] };

  const result = await invoke(
    llm,
    db,
    digestId,
    {
      model: DEFAULT_MODEL,
      system: CLUSTERING_SYSTEM,
      messages: [{ role: "user", content: buildClusteringPrompt(articles) }],
      maxTokens: articles.length * 30 + 500,
      schema: groupingSchema,
    },
    options,
  );
  if (!result.ok) return result;

  const validIds = new Set(articles.map((a) => a.id));
  const seen = new Set<string>();
  const invalid: string[] = [];
  const duplicated: string[] = [];

  for (const group of result.data.parsed.clusters) {
    for (const id of group.articleIds) {
      if (!validIds.has(id)) {
        invalid.push(id);
        continue;
      }
      if (seen.has(id)) {
        duplicated.push(id);
        continue;
      }
      seen.add(id);
    }
  }
  const missing = articles.filter((a) => !seen.has(a.id)).map((a) => a.id);

  if (invalid.length > 0 || duplicated.length > 0 || missing.length > 0) {
    const parts: string[] = [];
    if (invalid.length > 0) parts.push(`${invalid.length} unknown id(s)`);
    if (duplicated.length > 0) parts.push(`${duplicated.length} duplicated id(s)`);
    if (missing.length > 0) parts.push(`${missing.length} missing id(s)`);
    return {
      ok: false,
      reason: "malformed_output",
      message: `clustering did not partition the pool: ${parts.join(", ")}`,
    };
  }

  return { ok: true, data: result.data.parsed.clusters };
}
