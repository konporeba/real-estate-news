// WORKER-SIDE. Groups the flat article pool into clusters of same-story articles (FR-004) — the
// input the scorer (Phase 2) and the ranker (Phase 4) consume. A cluster is one story; an article
// covered by only one outlet is a cluster of one.
//
// Single-pass: the whole pool (~234 articles × ~75 tokens ≈ 17k tokens of title+lede) fits Sonnet's
// context comfortably, so this is one invoke() call (plus one corrective retry — see below), not a
// batched loop like scoring.
//
// LOCAL INDICES, NOT REAL IDS, IN THE PROMPT. A real run against ~360 articles measured the model
// needing well over 100 output tokens per article to echo every article's UUID back across the
// groups — a UUID's hyphens and hex chunks tokenize far less efficiently than a short index. On a
// non-streaming call (invoke() does not stream) a response that large risks the request timing out
// before it completes, however generous the client timeout, rather than merely costing more. Ids
// are localized to plain array-position strings ("0", "1", …) for the prompt and response, and
// mapped back to real article ids after parsing — cutting output size by roughly an order of
// magnitude with no change to the public contract (real ids in, real ids out).
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
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

Every article id given to you must appear in exactly one group — every id is used once, and no id is invented. Article ids are short numbers (e.g. "0", "7", "142") — echo the exact number given, not a new id.`;

interface LocalizedArticle {
  localId: string;
  title: string;
  lede: string | null;
}

function buildClusteringPrompt(articles: LocalizedArticle[]): string {
  const lines = articles.map((a) => `[id: ${a.localId}] ${a.title}${a.lede ? `\n  ${a.lede}` : ""}`);
  return `Group these ${articles.length} articles into stories. Every article id must appear in exactly one group.\n\n${lines.join("\n\n")}`;
}

type PartitionResult = { ok: true; clusters: ArticleCluster[] } | { ok: false; message: string };

/**
 * Check that a parsed grouping is a true partition of the local id space — no id dropped,
 * duplicated, or invented — and map local ids back to real article ids. Business-level
 * validation invoke()'s own schema check cannot do, since the schema has no idea what the
 * input id set was.
 */
function validatePartition(
  groups: { articleIds: string[] }[],
  localized: LocalizedArticle[],
  localToReal: Map<string, string>,
): PartitionResult {
  const validLocalIds = new Set(localized.map((a) => a.localId));
  const seen = new Set<string>();
  const invalid: string[] = [];
  const duplicated: string[] = [];
  const clusters: ArticleCluster[] = [];

  for (const group of groups) {
    const realIds: string[] = [];
    for (const localId of group.articleIds) {
      if (!validLocalIds.has(localId)) {
        invalid.push(localId);
        continue;
      }
      if (seen.has(localId)) {
        duplicated.push(localId);
        continue;
      }
      seen.add(localId);
      const realId = localToReal.get(localId);
      if (realId) realIds.push(realId);
    }
    clusters.push({ articleIds: realIds });
  }
  const missing = localized.filter((a) => !seen.has(a.localId)).map((a) => a.localId);

  if (invalid.length > 0 || duplicated.length > 0 || missing.length > 0) {
    const parts: string[] = [];
    if (invalid.length > 0) parts.push(`${invalid.length} unknown id(s)`);
    if (duplicated.length > 0) parts.push(`${duplicated.length} duplicated id(s)`);
    if (missing.length > 0) parts.push(`${missing.length} missing id(s)`);
    return { ok: false, message: parts.join(", ") };
  }

  return { ok: true, clusters };
}

/**
 * Cluster the pool into stories via invoke(), with one corrective retry on a bad partition.
 *
 * A real ~367-article pool measured the model occasionally dropping or duplicating a couple of
 * ids on a single-pass whole-pool grouping — not a schema problem (invoke()'s own reprompt
 * already guards that), but a business-rule miss invoke() cannot see. Mirrors invoke()'s own
 * pattern: replay the bad answer plus exactly what was wrong and ask once more, since the
 * alternative — failing the whole digest over an occasional near-miss on an otherwise-working
 * call — wastes the pool this stage exists to rank.
 */
export async function clusterArticles(
  llm: LlmTransport | null,
  db: ServiceClient,
  digestId: string,
  articles: ClusterableArticle[],
  options: { ceilingUsd: number },
): Promise<LlmResult<ArticleCluster[]>> {
  if (articles.length === 0) return { ok: true, data: [] };

  const localToReal = new Map<string, string>();
  const localized: LocalizedArticle[] = articles.map((a, index) => {
    const localId = String(index);
    localToReal.set(localId, a.id);
    return { localId, title: a.title, lede: a.lede };
  });

  const initialMessages: MessageParam[] = [{ role: "user", content: buildClusteringPrompt(localized) }];

  const first = await invoke(
    llm,
    db,
    digestId,
    {
      model: DEFAULT_MODEL,
      system: CLUSTERING_SYSTEM,
      messages: initialMessages,
      // Sonnet 5 runs adaptive thinking by default when `thinking` is omitted, and maxTokens
      // caps thinking + output together — a real run measured this consuming most of the
      // budget before the JSON partition was even written, truncating it regardless of how
      // large maxTokens was raised. This is a same-story grouping task with a fully-specified
      // rubric in the system prompt; it does not need open-ended deliberation, so thinking is
      // disabled and the whole budget goes to the partition itself.
      thinking: false,
      // Short indices instead of UUIDs cut the per-article cost a lot, but a real ~366-article
      // pool still measured truncation at 15/article + 1000 with thinking on — the per-group
      // JSON wrapper ("articleIds":[...]) plus a near-all-singleton grouping adds up. Budgeted
      // above the observed need; still an order of magnitude below the UUID-keyed cost this
      // replaced, and thinking being off means this budget is no longer shared with reasoning.
      maxTokens: articles.length * 35 + 2000,
      schema: groupingSchema,
    },
    options,
  );
  if (!first.ok) return first;

  const firstAttempt = validatePartition(first.data.parsed.clusters, localized, localToReal);
  if (firstAttempt.ok) return { ok: true, data: firstAttempt.clusters };

  const retryMessages: MessageParam[] = [
    ...initialMessages,
    { role: "assistant", content: first.data.text },
    {
      role: "user",
      content:
        `Your grouping did not correctly partition the articles: ${firstAttempt.message}. ` +
        `Every article id from 0 to ${articles.length - 1} must appear in exactly one group, with no id invented or repeated. ` +
        `Respond again with only valid JSON matching the schema, with a corrected grouping.`,
    },
  ];

  const second = await invoke(
    llm,
    db,
    digestId,
    {
      model: DEFAULT_MODEL,
      system: CLUSTERING_SYSTEM,
      messages: retryMessages,
      thinking: false,
      maxTokens: articles.length * 35 + 2000,
      schema: groupingSchema,
    },
    options,
  );
  if (!second.ok) return second;

  const secondAttempt = validatePartition(second.data.parsed.clusters, localized, localToReal);
  if (secondAttempt.ok) return { ok: true, data: secondAttempt.clusters };

  return {
    ok: false,
    reason: "malformed_output",
    message:
      `clustering did not partition the pool after a corrective retry — ` +
      `[1] ${firstAttempt.message} [2] ${secondAttempt.message}`,
  };
}
