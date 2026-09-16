// WORKER-SIDE (and Phase 5's app-side twin): posts the rendered images to the operator's Facebook
// Page via the Meta Graph API. Every image is uploaded as an unpublished Page photo first, then
// one feed post references all of them together — a single image still uses this same two-step
// shape (Facebook's single-photo endpoint could post directly), keeping one code path per platform
// rather than a single-vs-carousel branch inside this module.
import { truncateForPlatform } from "@/lib/publishing/caption";
import { createGraphClient, type GraphClient } from "@/lib/publishing/graph-api";
import type { Publisher, PublishAttempt } from "@/lib/publishing/types";

export interface FacebookCredentials {
  accessToken: string;
  pageId: string;
}

/** Effectively unbounded for this use case (Facebook's actual feed-post cap); kept for symmetry with the other platforms. */
export const FACEBOOK_MAX_CAPTION_LENGTH = 63_206;

/**
 * Build a Facebook publisher. Returns null when credentials are absent — the createEmailClient /
 * createSlidesClient precedent — so the caller surfaces `not_configured` instead of a crash.
 */
export function createFacebookPublisher(credentials: FacebookCredentials | null): Publisher | null {
  if (!credentials) return null;
  const client = createGraphClient(fetch, credentials.accessToken);
  return buildFacebookPublisher(credentials.pageId, client);
}

/** Split out so the request sequencing can be unit-tested against a fake Graph client. */
export function buildFacebookPublisher(pageId: string, client: GraphClient): Publisher {
  return {
    async publish(images, rawCaption): Promise<PublishAttempt> {
      if (images.length === 0) return { ok: false, error: "no images to publish" };
      const caption = truncateForPlatform(rawCaption, FACEBOOK_MAX_CAPTION_LENGTH);

      const photoIds: string[] = [];
      for (const image of images) {
        const uploaded = await client.post(`${pageId}/photos`, { url: image, published: "false" });
        if (!uploaded.ok) return uploaded;
        photoIds.push(String(uploaded.data.id));
      }

      const attachedMedia = JSON.stringify(photoIds.map((id) => ({ media_fbid: id })));
      const posted = await client.post(`${pageId}/feed`, { message: caption, attached_media: attachedMedia });
      if (!posted.ok) return posted;
      return { ok: true, postId: String(posted.data.id) };
    },
  };
}
