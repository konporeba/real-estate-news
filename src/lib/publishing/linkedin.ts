// WORKER-SIDE (and Phase 5's app-side twin): posts the rendered images to the operator's LinkedIn
// Company Page. LinkedIn's Images API requires registering each image (initialize upload, then PUT
// the image bytes to the returned upload URL) before it can be referenced in a post — unlike Meta's
// APIs, LinkedIn does not fetch an image URL on our behalf, so this module downloads each signed
// asset URL itself and re-uploads the bytes.
//
// **Re-confirm the API surface against LinkedIn's current developer docs at implementation/dry-run
// time** — the plan's own caveat. LinkedIn organization-page posting also generally requires the
// Community Management API product, an application/review process with its own external lead time
// (structurally the same as S-06's Canva access dependency) — file that request early, independent
// of this module's code.
import { truncateForPlatform } from "@/lib/publishing/caption";
import type { Publisher, PublishAttempt } from "@/lib/publishing/types";

export interface LinkedinCredentials {
  accessToken: string;
  organizationUrn: string;
}

const LINKEDIN_API = "https://api.linkedin.com/rest";
const LINKEDIN_API_VERSION = "202405";

/** LinkedIn's organization-post commentary limit. Re-confirm against current docs at dry-run time. */
export const LINKEDIN_MAX_CAPTION_LENGTH = 3000;

/**
 * Build a LinkedIn publisher. Returns null when credentials are absent — the createEmailClient /
 * createSlidesClient precedent — so the caller surfaces `not_configured` instead of a crash.
 */
export function createLinkedinPublisher(credentials: LinkedinCredentials | null): Publisher | null {
  if (!credentials) return null;
  return buildLinkedinPublisher(credentials, fetch);
}

async function errorFromResponse(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `LinkedIn API error: ${String(response.status)} ${response.statusText}: ${body.slice(0, 500)}`;
}

/** Split out so the upload/post sequencing can be unit-tested against a fake fetch. */
export function buildLinkedinPublisher(credentials: LinkedinCredentials, fetchImpl: typeof fetch): Publisher {
  const { accessToken, organizationUrn } = credentials;

  function authHeaders(extra: Record<string, string> = {}): HeadersInit {
    return {
      authorization: `Bearer ${accessToken}`,
      "linkedin-version": LINKEDIN_API_VERSION,
      "x-restli-protocol-version": "2.0.0",
      ...extra,
    };
  }

  async function registerImage(imageUrl: string): Promise<{ ok: true; urn: string } | { ok: false; error: string }> {
    let initResponse: Response;
    try {
      initResponse = await fetchImpl(`${LINKEDIN_API}/images?action=initializeUpload`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ initializeUploadRequest: { owner: organizationUrn } }),
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!initResponse.ok) return { ok: false, error: await errorFromResponse(initResponse) };

    let uploadUrl: string;
    let imageUrn: string;
    try {
      const json = (await initResponse.json()) as { value?: { uploadUrl?: string; image?: string } };
      if (!json.value?.uploadUrl || !json.value.image) {
        return { ok: false, error: "initializeUpload response carried no uploadUrl/image" };
      }
      uploadUrl = json.value.uploadUrl;
      imageUrn = json.value.image;
    } catch (error) {
      return { ok: false, error: `initializeUpload response was not JSON: ${String(error)}` };
    }

    let imageBytes: Response;
    try {
      imageBytes = await fetchImpl(imageUrl);
    } catch (error) {
      return {
        ok: false,
        error: `failed to fetch source image: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!imageBytes.ok) {
      return {
        ok: false,
        error: `failed to fetch source image: ${String(imageBytes.status)} ${imageBytes.statusText}`,
      };
    }

    // uploadUrl is pre-signed, like the Slides thumbnail contentUrl — sending our own auth headers
    // to it can make LinkedIn reject the request, so it is fetched bare.
    let putResponse: Response;
    try {
      putResponse = await fetchImpl(uploadUrl, { method: "PUT", body: await imageBytes.arrayBuffer() });
    } catch (error) {
      return { ok: false, error: `image upload failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!putResponse.ok) {
      return { ok: false, error: `image upload failed: ${String(putResponse.status)} ${putResponse.statusText}` };
    }

    return { ok: true, urn: imageUrn };
  }

  return {
    async publish(images, rawCaption): Promise<PublishAttempt> {
      if (images.length === 0) return { ok: false, error: "no images to publish" };
      const caption = truncateForPlatform(rawCaption, LINKEDIN_MAX_CAPTION_LENGTH);

      const urns: string[] = [];
      for (const image of images) {
        const registered = await registerImage(image);
        if (!registered.ok) return registered;
        urns.push(registered.urn);
      }

      let postResponse: Response;
      try {
        postResponse = await fetchImpl(`${LINKEDIN_API}/posts`, {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            author: organizationUrn,
            commentary: caption,
            visibility: "PUBLIC",
            distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
            // A single image still goes through multiImage with one element — one code path
            // rather than a single-vs-multi content-block branch, mirroring facebook.ts's rationale.
            content: { multiImage: { images: urns.map((id) => ({ id })) } },
            lifecycleState: "PUBLISHED",
            isReshareDisabledByAuthor: false,
          }),
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!postResponse.ok) return { ok: false, error: await errorFromResponse(postResponse) };

      const postId = postResponse.headers.get("x-restli-id");
      if (!postId) return { ok: false, error: "post created but response carried no x-restli-id header" };
      return { ok: true, postId };
    },
  };
}
