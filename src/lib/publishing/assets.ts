// SHARED between both runtimes, like src/lib/digest/assets.ts. Gives the publisher modules
// fetchable URLs for images that live in the private `digest-assets` bucket, since Instagram,
// Facebook, and LinkedIn's APIs all need a URL (or an upload) they can reach, not a Supabase
// Storage path.
import { ASSET_BUCKET } from "@/lib/digest/assets";
import type { ServiceClient } from "@/lib/supabase-service";

/**
 * How long a publish-path image URL stays valid.
 *
 * `SIGNED_URL_TTL_SECONDS` (10 minutes, in `src/lib/digest/assets.ts`) is sized for "the browser
 * fetching images on a page it has just loaded" — a different consumer than Meta's or LinkedIn's
 * servers fetching a URL asynchronously sometime after the publish call returns (container
 * processing on Instagram in particular is not instantaneous). A few times longer gives that
 * asynchronous fetch real headroom without reusing a TTL whose rationale does not transfer.
 * Phase 6's live dry run is what confirms whether this is long enough in practice.
 */
export const PUBLISH_SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Sign a batch of storage paths for external platform consumption. Returns a map from storage
 * path to signed URL, containing only the paths that signed successfully — mirrors the approve
 * page's own `urlByPath` construction (`src/pages/dashboard/[id]/approve.astro`), so a caller
 * checks for a missing entry the same way that page already does, rather than this helper
 * inventing a second error shape for what is ultimately a partial-batch outcome.
 */
export async function signAssetUrls(
  client: ServiceClient,
  storagePaths: readonly string[],
): Promise<Map<string, string>> {
  if (storagePaths.length === 0) return new Map();

  const { data: signed, error } = await client.storage
    .from(ASSET_BUCKET)
    .createSignedUrls([...storagePaths], PUBLISH_SIGNED_URL_TTL_SECONDS);

  if (error) {
    console.error(`failed to sign ${String(storagePaths.length)} asset URL(s) for publishing: ${error.message}`);
    return new Map();
  }

  const failed = signed.filter((entry) => !entry.signedUrl);
  if (failed.length > 0) {
    console.error(
      `failed to sign ${String(failed.length)}/${String(signed.length)} asset URL(s) for publishing ` +
        `in bucket ${ASSET_BUCKET}: ${failed[0]?.error ?? "no reason given"}`,
    );
  }

  return new Map(
    signed
      .filter((entry): entry is typeof entry & { path: string; signedUrl: string } =>
        Boolean(entry.path && entry.signedUrl),
      )
      .map((entry) => [entry.path, entry.signedUrl]),
  );
}
