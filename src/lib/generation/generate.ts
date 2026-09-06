// WORKER-SIDE. The generation stage: everything between "a digest exists in `generating`" and
// "the digest is in `ready_for_approval` or `failed`". Composes source-text fetching (Phase 3),
// copy generation (Phase 4) and the numeric gate (Phase 2), persists the result, and transitions
// the digest — mirroring the ranking stage's orchestrator (`src/lib/ranking/rank.ts`).
//
// Convention shared with rankDigest() and collect(): an infrastructure-level failure (a Postgres
// error mid-run) is returned raw so the caller sees a stage that did not run to completion. A
// GENUINE failure — no confirmed selection, no picked stories, an LLM error including a ceiling
// hit, or copy that fails the numeric gate after its corrective retry — is instead handled by
// transitioning the digest to `failed` with a diagnostic in `last_error`, and the function still
// returns `ok: true`: the stage ran to completion, it just concluded the digest cannot proceed.
// Callers check `outcome.data.digest.status` to tell the two apart.
//
// A FETCH failure is deliberately NOT a genuine failure. Idealista is enabled and known to block
// us, and paywalls are routine; one refused page must not cost the operator the whole week. Those
// stories fall back to the stored title + lede and record `source_text_origin = 'lede'`.
import { markStageComplete, transitionDigest } from "@/lib/digest/run-state";
import { generateCopy } from "@/lib/generation/generate-copy";
import { assertFiguresPresent, describeMissing, extractFigures } from "@/lib/generation/numerals";
import { fetchArticleText } from "@/lib/generation/source-text";
import type { LlmTransport } from "@/lib/llm/client";
import type { ServiceClient } from "@/lib/supabase-service";
import type { DigestRun, KeyStatistic, RunStateResult, SelectionFormat, SourceTextOrigin } from "@/types";

export interface GenerateOptions {
  ceilingUsd: number;
  /** Injectable so the orchestrator's tests never touch the network. */
  fetchImpl?: typeof fetch;
}

export interface GenerateOutcome {
  digest: DigestRun;
  /** Stories persisted this run. 0 when the stage concluded in `failed` before persisting. */
  storyCount: number;
}

/** One picked story, as the stage reads it out of the database. */
interface PickedStory {
  clusterId: string;
  title: string;
  lede: string | null;
  sourceUrl: string;
}

function databaseFail(error: { code: string; message: string }): RunStateResult<never> {
  return { ok: false, reason: "database_error", message: `${error.code}: ${error.message}` };
}

/** The genuine-failure path: transition to `failed` with a diagnostic, but return `ok: true`. */
async function failDigest(
  client: ServiceClient,
  digestId: string,
  message: string,
): Promise<RunStateResult<GenerateOutcome>> {
  const failed = await transitionDigest(client, digestId, "failed", { lastError: message });
  if (!failed.ok) return failed;
  return { ok: true, data: { digest: failed.data, storyCount: 0 } };
}

/**
 * Read what the operator actually picked at the S-04 gate, with each cluster's representative
 * article.
 *
 * The representative rule is the one `src/pages/dashboard/[id].astro` and `rank.ts` both use:
 * whichever article carries a Polish translation (at most one per cluster, per translateShortlist's
 * scope), else the earliest published. That matters here because it is the story the operator
 * read before choosing it — generating from a different article of the same cluster would adapt
 * something he never saw.
 */
async function fetchPickedStories(
  client: ServiceClient,
  digestId: string,
): Promise<RunStateResult<{ format: SelectionFormat; stories: PickedStory[] }>> {
  const { data: selection, error: selectionError } = await client
    .from("selection")
    .select("id, format")
    .eq("digest_id", digestId)
    .maybeSingle();
  if (selectionError) return databaseFail(selectionError);
  if (!selection) return { ok: true, data: { format: "single_post", stories: [] } };

  const { data: items, error: itemsError } = await client
    .from("selection_item")
    .select("cluster_id")
    .eq("selection_id", selection.id)
    .eq("picked", true);
  if (itemsError) return databaseFail(itemsError);

  const clusterIds = items.map((item) => item.cluster_id);
  if (clusterIds.length === 0) {
    return { ok: true, data: { format: selection.format, stories: [] } };
  }

  const { data: articles, error: articlesError } = await client
    .from("article")
    .select("cluster_id, source_url, original_title, original_lede, polish_title")
    .in("cluster_id", clusterIds)
    .order("published_at", { ascending: true });
  if (articlesError) return databaseFail(articlesError);

  const byCluster = new Map<string, typeof articles>();
  for (const article of articles) {
    if (!article.cluster_id) continue;
    const list = byCluster.get(article.cluster_id) ?? [];
    list.push(article);
    byCluster.set(article.cluster_id, list);
  }

  const stories = clusterIds.flatMap((clusterId): PickedStory[] => {
    const clusterArticles = byCluster.get(clusterId) ?? [];
    const representative = clusterArticles.find((a) => a.polish_title) ?? clusterArticles.at(0);
    // A picked cluster with no articles cannot happen (clusters are built from articles), but
    // dropping it beats throwing mid-stage — the same call fetchDigestReadyItems makes.
    if (!representative) return [];
    return [
      {
        clusterId,
        title: representative.original_title,
        lede: representative.original_lede,
        sourceUrl: representative.source_url,
      },
    ];
  });

  return { ok: true, data: { format: selection.format, stories } };
}

/**
 * Re-runs regenerate from scratch rather than resuming.
 *
 * The precedent is `clearExistingClusters` in rank.ts, and the reason is the same: resuming would
 * let a prompt or model change produce a digest whose stories were written by different
 * configurations, and that inconsistency is invisible until the operator reads it. At 2-4 stories
 * the re-paid cost is cents.
 */
async function clearExistingCopy(client: ServiceClient, digestId: string): Promise<RunStateResult<void>> {
  const { error } = await client.from("generated_copy").delete().eq("digest_id", digestId);
  if (error) return databaseFail(error);
  return { ok: true, data: undefined };
}

interface StoryResult {
  clusterId: string;
  polishTitle: string;
  captionSummary: string;
  bodyCopy: string;
  keyStatistics: KeyStatistic[];
  sourceTextOrigin: SourceTextOrigin;
  sourceCharCount: number;
}

/** All of a story's generated text, as one string for the gate to search. */
function searchableOutput(copy: {
  polishTitle: string;
  captionSummary: string;
  bodyCopy: string;
  keyStatistics: KeyStatistic[];
}): string {
  return [copy.polishTitle, copy.captionSummary, copy.bodyCopy, ...copy.keyStatistics.map((s) => s.value)].join("\n");
}

/**
 * Generate one story and hold it to FR-014.
 *
 * The gate gets ONE corrective retry, mirroring `clusterArticles`'s partition retry: the model is
 * told exactly which figures went missing and asked again. A second failure is genuine — US-12 is
 * explicit that wrong figures fail the run rather than publish.
 *
 * Returns `{ ok: false }` with a human-readable reason for `last_error`; the caller decides that
 * this fails the digest.
 */
async function generateStory(
  llm: LlmTransport | null,
  client: ServiceClient,
  digestId: string,
  story: PickedStory,
  format: SelectionFormat,
  options: GenerateOptions,
): Promise<{ ok: true; data: StoryResult } | { ok: false; message: string }> {
  const fetched = await fetchArticleText(story.sourceUrl, { fetchImpl: options.fetchImpl });
  const sourceText = fetched.ok ? fetched.text : `${story.title}. ${story.lede ?? ""}`.trim();
  const sourceTextOrigin: SourceTextOrigin = fetched.ok ? "article" : "lede";

  const sourceFigures = extractFigures(sourceText);

  // Carries the first attempt's missing figures into the retry's correction. Without this the
  // retry would be a plain re-roll: the model would be told it failed but not what it dropped,
  // which is the difference between a corrective reprompt and hoping for better luck.
  let missingFromLastAttempt = "";

  for (const attempt of [0, 1]) {
    const correction =
      attempt === 0
        ? undefined
        : "Your previous attempt dropped or altered figures from the source. These figures MUST appear " +
          "in your output exactly as the source states them (Polish number formatting is fine, but the " +
          `value must not change): ${missingFromLastAttempt}`;

    const generated = await generateCopy(llm, client, digestId, { title: story.title, sourceText }, format, {
      ceilingUsd: options.ceilingUsd,
      correction,
    });
    if (!generated.ok) {
      return { ok: false, message: `generation ${generated.reason}: ${generated.message}` };
    }

    const check = assertFiguresPresent(sourceFigures, searchableOutput(generated.data));
    if (check.ok) {
      return {
        ok: true,
        data: {
          clusterId: story.clusterId,
          ...generated.data,
          sourceTextOrigin,
          sourceCharCount: sourceText.length,
        },
      };
    }

    if (attempt === 1) {
      return {
        ok: false,
        message: `numeric integrity failed for "${story.title}" after a corrective retry; missing ${describeMissing(check.missing)}`,
      };
    }

    missingFromLastAttempt = check.missing.map((figure) => figure.raw).join(", ");
  }

  // Unreachable: the loop either returns a result or fails on its second attempt.
  return { ok: false, message: "generation produced no result" };
}

async function persistCopy(
  client: ServiceClient,
  digestId: string,
  results: StoryResult[],
): Promise<RunStateResult<void>> {
  const { error } = await client.from("generated_copy").insert(
    results.map((r) => ({
      digest_id: digestId,
      cluster_id: r.clusterId,
      polish_title: r.polishTitle,
      caption_summary: r.captionSummary,
      body_copy: r.bodyCopy,
      key_statistics: r.keyStatistics,
      source_text_origin: r.sourceTextOrigin,
      source_char_count: r.sourceCharCount,
    })),
  );
  if (error) return databaseFail(error);
  return { ok: true, data: undefined };
}

/**
 * Run generation for a digest that is in `generating`. Assumes the caller (the worker entrypoint)
 * has already checked the digest's status — the same split of responsibility `rankDigest` uses.
 *
 * Stories are generated SEQUENTIALLY, not concurrently. F-03's ceiling is soft: its check and its
 * cost increment are separate round trips, so the overshoot bound under concurrency is
 * `concurrency x per-call cost`. At 2-4 stories there is nothing to gain from parallelism and a
 * sequential loop keeps the ceiling as tight as it can be.
 */
export async function generateDigest(
  llm: LlmTransport | null,
  client: ServiceClient,
  digest: DigestRun,
  options: GenerateOptions,
): Promise<RunStateResult<GenerateOutcome>> {
  const picked = await fetchPickedStories(client, digest.id);
  if (!picked.ok) return picked;

  if (picked.data.stories.length === 0) {
    return failDigest(client, digest.id, "no confirmed selection with picked stories; nothing to generate");
  }

  const cleared = await clearExistingCopy(client, digest.id);
  if (!cleared.ok) return cleared;

  const results: StoryResult[] = [];
  for (const story of picked.data.stories) {
    const generated = await generateStory(llm, client, digest.id, story, picked.data.format, options);
    if (!generated.ok) return failDigest(client, digest.id, generated.message);
    results.push(generated.data);
  }

  const persisted = await persistCopy(client, digest.id, results);
  if (!persisted.ok) return persisted;

  const checkpointed = await markStageComplete(client, digest.id, "generation");
  if (!checkpointed.ok) return checkpointed;

  const transitioned = await transitionDigest(client, digest.id, "ready_for_approval");
  if (!transitioned.ok) return transitioned;

  return { ok: true, data: { digest: transitioned.data, storyCount: results.length } };
}
