// SHARED between both runtimes: the worker's scheduled/manual publish entrypoint (Phase 4) and the
// dashboard's "Publish now" API route (Phase 5) both call this, so "which platforms still need
// publishing" and "attempt once, record, move on" are decided in exactly one place regardless of
// which path invoked it -- a scheduled fire and a manual retrigger can never disagree.
import { composeCaption } from "@/lib/publishing/caption";
import { signAssetUrls } from "@/lib/publishing/assets";
import type { Publisher } from "@/lib/publishing/types";
import type { ServiceClient } from "@/lib/supabase-service";
import type {
  DigestStatus,
  PublicationError,
  PublicationResult,
  PublishOutcome,
  PublishSummary,
  SelectionPlatform,
} from "@/types";

/** A digest a publish attempt may legally target: not yet published, or catching a late platform up. */
const PUBLISHABLE_STATUSES: DigestStatus[] = ["approved", "skipped", "published"];

function fail(reason: PublicationError["reason"], message: string): PublicationError {
  return { ok: false, reason, message };
}

function databaseFail(error: { code: string; message: string }): PublicationError {
  return fail("database_error", `${error.code}: ${error.message}`);
}

/** Maps record_publication's own SQLSTATEs (see the migration's header) onto the same taxonomy. */
function mapRecordError(error: { code: string; message: string }): PublicationError {
  if (error.code === "PB001") return fail("not_found", error.message);
  if (error.code === "PB002") return fail("wrong_status", error.message);
  return databaseFail(error);
}

/**
 * Run publishing for a digest against whichever platforms it was selected for and haven't already
 * succeeded. `publishers` maps each platform to its client, or omits/nulls one that has no
 * credentials configured -- the caller (worker or API route) builds this from its own environment.
 */
export async function runPublish(
  client: ServiceClient,
  digestId: string,
  publishers: Partial<Record<SelectionPlatform, Publisher>>,
): Promise<PublicationResult<PublishSummary>> {
  const { data: digest, error: digestError } = await client
    .from("digest")
    .select("status")
    .eq("id", digestId)
    .maybeSingle();
  if (digestError) return databaseFail(digestError);
  if (!digest) return fail("not_found", `no digest ${digestId}`);
  if (!PUBLISHABLE_STATUSES.includes(digest.status)) {
    return fail("wrong_status", `digest is "${digest.status}", not approved, skipped, or published`);
  }

  const { data: selection, error: selectionError } = await client
    .from("selection")
    .select("platforms")
    .eq("digest_id", digestId)
    .maybeSingle();
  if (selectionError) return databaseFail(selectionError);
  // No confirmed selection means nothing was ever chosen to publish -- not an error, just nothing
  // pending, the same "empty summary" outcome as every platform already having succeeded.
  if (!selection) return { ok: true, data: [] };

  const { data: existing, error: existingError } = await client
    .from("publication")
    .select("platform, status")
    .eq("digest_id", digestId);
  if (existingError) return databaseFail(existingError);

  const alreadySucceeded = new Set(existing.filter((row) => row.status === "success").map((row) => row.platform));
  const pending = selection.platforms.filter((platform) => !alreadySucceeded.has(platform));
  if (pending.length === 0) return { ok: true, data: [] };

  // Images and captions, in one consistent order: both are derived by walking the same
  // slide_index-ordered generated_asset query, so a carousel's caption text lists stories in
  // exactly the order the images show them, rather than two independently-ordered queries risking
  // a mismatch (plan-review F1).
  const { data: assets, error: assetsError } = await client
    .from("generated_asset")
    .select("cluster_id, storage_path")
    .eq("digest_id", digestId)
    .order("slide_index", { ascending: true });
  if (assetsError) return databaseFail(assetsError);

  const { data: copyRows, error: copyError } = await client
    .from("generated_copy")
    .select("cluster_id, caption_summary")
    .eq("digest_id", digestId);
  if (copyError) return databaseFail(copyError);
  const captionByCluster = new Map(copyRows.map((row) => [row.cluster_id, row.caption_summary]));

  const signedByPath = await signAssetUrls(
    client,
    assets.map((asset) => asset.storage_path),
  );
  // A path that failed to sign is dropped rather than failing the whole run -- the same
  // permissiveness the approve page already applies to the identical signing step.
  const images = assets.flatMap((asset) => {
    const url = signedByPath.get(asset.storage_path);
    return url ? [url] : [];
  });
  const summaries = assets.flatMap((asset) => {
    if (!asset.cluster_id) return [];
    const summary = captionByCluster.get(asset.cluster_id);
    return summary ? [summary] : [];
  });
  const caption = composeCaption(summaries);

  const summary: PublishSummary = [];
  for (const platform of pending) {
    const publisher = publishers[platform];
    const outcome: PublishOutcome = publisher
      ? toOutcome(platform, await publisher.publish(images, caption))
      : { platform, ok: false, error: "not_configured" };
    summary.push(outcome);

    const { error: recordError } = await client.rpc("record_publication", {
      p_digest_id: digestId,
      p_platform: platform,
      p_status: outcome.ok ? "success" : "failure",
      p_post_id: outcome.ok ? outcome.postId : null,
      p_error: outcome.ok ? null : outcome.error,
    });
    // record_publication failing mid-run is an infrastructure failure, not a platform outcome --
    // surface it distinctly rather than silently dropping the rest of this run's platforms.
    if (recordError) return mapRecordError(recordError);
  }

  return { ok: true, data: summary };
}

function toOutcome(platform: SelectionPlatform, attempt: Awaited<ReturnType<Publisher["publish"]>>): PublishOutcome {
  return attempt.ok ? { platform, ok: true, postId: attempt.postId } : { platform, ok: false, error: attempt.error };
}
