// WORKER-SIDE (and Phase 5's app-side twin): posts the rendered images to the operator's Instagram
// Business account via the Meta Graph API's container-then-publish flow.
//
// Container creation is ASYNCHRONOUS on Meta's side: a container's `status_code` starts
// `IN_PROGRESS` and must reach `FINISHED` before `/media_publish` will succeed (a premature
// publish call fails with error code 9007) — so every container (child, parent, or the
// single-image container) is polled to completion before it is ever handed to media_publish.
import { truncateForPlatform } from "@/lib/publishing/caption";
import { createGraphClient, type GraphClient } from "@/lib/publishing/graph-api";
import type { Publisher, PublishAttempt } from "@/lib/publishing/types";

export interface InstagramCredentials {
  accessToken: string;
  igUserId: string;
}

/** Bounded so a stuck container fails the platform, not the whole run — matches the "no retry within a run" contract. */
const MAX_CONTAINER_POLL_ATTEMPTS = 10;
const CONTAINER_POLL_INTERVAL_MS = 2000;

/** Instagram's caption limit. Applied here, not by the orchestrator, so runPublish stays platform-agnostic. */
export const INSTAGRAM_MAX_CAPTION_LENGTH = 2200;

/**
 * Build an Instagram publisher. Returns null when credentials are absent — the createEmailClient /
 * createSlidesClient precedent — so the caller surfaces `not_configured` instead of a crash.
 */
export function createInstagramPublisher(credentials: InstagramCredentials | null): Publisher | null {
  if (!credentials) return null;
  const client = createGraphClient(fetch, credentials.accessToken);
  return buildInstagramPublisher(
    credentials.igUserId,
    client,
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
}

/**
 * Split out from createInstagramPublisher so the container-then-publish sequencing, including the
 * polling loop, can be unit-tested against a fake Graph client and a fake sleep — without a real
 * access token, a real network, or real polling delays.
 */
export function buildInstagramPublisher(
  igUserId: string,
  client: GraphClient,
  sleepImpl: (ms: number) => Promise<void>,
): Publisher {
  async function waitUntilFinished(containerId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    for (let attempt = 0; attempt < MAX_CONTAINER_POLL_ATTEMPTS; attempt++) {
      const result = await client.get(containerId, { fields: "status_code" });
      if (!result.ok) return result;

      const statusCode = result.data.status_code;
      if (statusCode === "FINISHED") return { ok: true };
      if (statusCode === "ERROR") {
        return { ok: false, error: `container ${containerId} failed processing (status_code=ERROR)` };
      }
      if (attempt < MAX_CONTAINER_POLL_ATTEMPTS - 1) await sleepImpl(CONTAINER_POLL_INTERVAL_MS);
    }
    return {
      ok: false,
      error: `container ${containerId} did not finish processing after ${String(MAX_CONTAINER_POLL_ATTEMPTS)} polling attempts`,
    };
  }

  async function createContainerAndWait(
    params: Record<string, string>,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const created = await client.post(`${igUserId}/media`, params);
    if (!created.ok) return created;

    const id = String(created.data.id);
    const waited = await waitUntilFinished(id);
    if (!waited.ok) return waited;
    return { ok: true, id };
  }

  return {
    async publish(images, rawCaption): Promise<PublishAttempt> {
      if (images.length === 0) return { ok: false, error: "no images to publish" };
      const caption = truncateForPlatform(rawCaption, INSTAGRAM_MAX_CAPTION_LENGTH);

      let creationId: string;
      if (images.length === 1) {
        const single = await createContainerAndWait({ image_url: images[0], caption });
        if (!single.ok) return single;
        creationId = single.id;
      } else {
        const childIds: string[] = [];
        for (const image of images) {
          const child = await createContainerAndWait({ image_url: image, is_carousel_item: "true" });
          if (!child.ok) return child;
          childIds.push(child.id);
        }
        // The carousel parent container's `children` field is a comma-separated list of the
        // already-created child container ids, not a JSON array.
        const parent = await createContainerAndWait({ media_type: "CAROUSEL", children: childIds.join(","), caption });
        if (!parent.ok) return parent;
        creationId = parent.id;
      }

      const published = await client.post(`${igUserId}/media_publish`, { creation_id: creationId });
      if (!published.ok) return published;
      return { ok: true, postId: String(published.data.id) };
    },
  };
}
