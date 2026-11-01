// WORKER-SIDE. The generation stage: everything between "a digest exists in `generating`" and
// "the digest is in `rendering` or `failed`". Composes source-text fetching (Phase 3),
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
import {
  assertFiguresPresent,
  assertNoInventedFigures,
  describeInvented,
  describeMissing,
  extractFigures,
} from "@/lib/generation/numerals";
import { fetchArticleText } from "@/lib/generation/source-text";
import type { LlmTransport } from "@/lib/llm/client";
import { MIN_PICKS } from "@/lib/selection/rules";
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
  /** Picked stories left out of the week because their copy could not be produced safely. */
  dropped: DroppedStory[];
}

/** A picked story the stage left out, and why — for the worker log and the approval page. */
export interface DroppedStory {
  clusterId: string;
  title: string;
  reason: string;
}

/**
 * Why one story could not be generated. `story` failures leave that story out: a figure check it
 * cannot pass, a refusal, output the model could not shape — and an API error, because the one
 * observed in practice was article-specific (a figure-dense table that timed out three times while
 * the other stories went through). A real outage still fails the week: every story errors, fewer
 * than MIN_PICKS remain, and the bound below stops the run. `infrastructure` — the cost ceiling or
 * a missing key — would hit every remaining story identically, so it fails the week at once.
 */
type StoryFailureKind = "story" | "infrastructure";

const INFRASTRUCTURE_REASONS = new Set(["ceiling_reached", "not_configured"]);

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
  return { ok: true, data: { digest: failed.data, storyCount: 0, dropped: [] } };
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
 *
 * Called IMMEDIATELY BEFORE the insert, not at the top of the stage. Since a failed generation can
 * now be retried in place (impl-review F2), clearing first would let a retry that fails again
 * leave the digest with no copy at all -- destroying a previous good run to produce nothing.
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
 * told exactly which key figures went missing and which figures it invented, and asked again. A
 * second failure is genuine — US-12 is explicit that wrong figures never publish.
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
): Promise<{ ok: true; data: StoryResult } | { ok: false; kind: StoryFailureKind; message: string }> {
  const fetched = await fetchArticleText(story.sourceUrl, { fetchImpl: options.fetchImpl });
  const sourceText = fetched.ok ? fetched.text : `${story.title}. ${story.lede ?? ""}`.trim();
  const sourceTextOrigin: SourceTextOrigin = fetched.ok ? "article" : "lede";

  // FR-014 as decided 2026-10-31: the figures of the story's HEADLINE AND LEAD must survive (the
  // facts the operator picked it for), and NO figure may appear in the copy that the source does
  // not contain. Requiring every figure in the article made a figure-dense story (a table of
  // rates) impossible to adapt into a post, and never caught an invented or rounded number.
  const keyFigures = extractFigures(`${story.title}\n${story.lede ?? ""}`);
  const knownText = `${story.title}\n${story.lede ?? ""}\n${sourceText}`;

  // Carries the first attempt's problems into the retry's correction. Without this the retry
  // would be a plain re-roll: the model would be told it failed but not why, which is the
  // difference between a corrective reprompt and hoping for better luck.
  let problemsWithLastAttempt = "";

  for (const attempt of [0, 1]) {
    const correction = attempt === 0 ? undefined : problemsWithLastAttempt;

    const generated = await generateCopy(llm, client, digestId, { title: story.title, sourceText }, format, {
      ceilingUsd: options.ceilingUsd,
      correction,
    });
    if (!generated.ok) {
      return {
        ok: false,
        kind: INFRASTRUCTURE_REASONS.has(generated.reason) ? "infrastructure" : "story",
        message: `generation ${generated.reason}: ${generated.message}`,
      };
    }

    const output = searchableOutput(generated.data);
    const missing = assertFiguresPresent(keyFigures, output);
    const invented = assertNoInventedFigures(knownText, output);
    if (missing.ok && invented.ok) {
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

    const problems = [
      missing.ok ? null : `missing ${describeMissing(missing.missing)}`,
      invented.ok ? null : `invented ${describeInvented(invented.invented)}`,
    ].filter((problem) => problem !== null);

    if (attempt === 1) {
      return {
        ok: false,
        kind: "story",
        message: `numeric integrity failed for "${story.title}" after a corrective retry; ${problems.join("; ")}`,
      };
    }

    problemsWithLastAttempt = [
      missing.ok
        ? null
        : "These figures from the story's headline or lead MUST appear in your output exactly as the source " +
          "states them (Polish number formatting is fine, but the value must not change): " +
          missing.missing.map((figure) => figure.raw).join(", "),
      invented.ok
        ? null
        : "These figures in your output do not appear in the source — remove them or replace them with the " +
          "exact figure the source gives; never round, convert or estimate: " +
          invented.invented.map((figure) => figure.raw).join(", "),
    ]
      .filter((line) => line !== null)
      .join("\n");
  }

  // Unreachable: the loop either returns a result or fails on its second attempt.
  return { ok: false, kind: "story", message: "generation produced no result" };
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

  const results: StoryResult[] = [];
  const dropped: DroppedStory[] = [];
  for (const story of picked.data.stories) {
    const generated = await generateStory(llm, client, digest.id, story, picked.data.format, options);
    if (generated.ok) {
      results.push(generated.data);
      continue;
    }
    if (generated.kind === "infrastructure") return failDigest(client, digest.id, generated.message);
    // The article cannot be adapted safely: leave it out rather than lose the whole week to it.
    // The approval page lists it as "Not included", so the operator sees exactly what happened.
    dropped.push({ clusterId: story.clusterId, title: story.title, reason: generated.message });
  }

  // Leaving stories out must never take the week below FR-012's lower bound. (The selection gate
  // owns that bound for what was picked; this only guards what the drops leave behind.)
  if (dropped.length > 0 && results.length < MIN_PICKS) {
    return failDigest(
      client,
      digest.id,
      `only ${String(results.length)} of ${String(picked.data.stories.length)} stories could be generated; ` +
        `at least ${String(MIN_PICKS)} are needed. ${dropped.map((story) => story.reason).join(" | ")}`,
    );
  }

  const cleared = await clearExistingCopy(client, digest.id);
  if (!cleared.ok) return cleared;

  const persisted = await persistCopy(client, digest.id, results);
  if (!persisted.ok) return persisted;

  const checkpointed = await markStageComplete(client, digest.id, "generation");
  if (!checkpointed.ok) return checkpointed;

  // S-06: the approval gate reviews the complete post, copy AND visuals, so generation hands off
  // to the rendering stage rather than straight to `ready_for_approval`.
  const transitioned = await transitionDigest(client, digest.id, "rendering");
  if (!transitioned.ok) return transitioned;

  return { ok: true, data: { digest: transitioned.data, storyCount: results.length, dropped } };
}
