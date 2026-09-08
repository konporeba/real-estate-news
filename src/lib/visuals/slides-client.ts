// WORKER-SIDE. Constructs the Google Slides transport without reading any environment of its own,
// mirroring src/lib/llm/client.ts and src/lib/email/client.ts so this module resolves in the worker
// and in Vitest alike. The worker builds the credentials from src/worker/env.ts and passes them in.
//
// WHY GOOGLE SLIDES AT ALL: FR-015 wants the operator to own the design in a visual editor, with
// the system filling named slots and no code change to restyle. Canva's Autofill API would have
// been the closest fit, but it requires the acting user to be a member of a Canva Enterprise
// organization -- for autofilling a plain design as much as a brand template -- which the operator
// verified against their own account. Slides gives the same shape for free.
//
// WHY RAW REST rather than the `googleapis` package: only three calls are needed, and
// `googleapis` bundles every Google API surface. google-auth-library alone signs the JWT and
// mints the access token; `fetch` does the rest.
//
// SCOPE IS DELIBERATELY MINIMAL. `presentations` covers batchUpdate AND pages.getThumbnail, so no
// Drive scope is requested. That matters beyond tidiness: without a Drive scope this credential
// cannot enumerate, read or delete anything in the operator's Drive that they have not explicitly
// shared with it.
import { JWT } from "google-auth-library";

/** The only scope this integration needs; covers both batchUpdate and pages.getThumbnail. */
export const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";

const SLIDES_API = "https://slides.googleapis.com/v1/presentations";

/**
 * Why a Slides call did not produce what the caller asked for. Mirrors {@link LlmErrorReason} and
 * {@link EmailErrorReason}: these are expected results a stage handles, not exceptions.
 *
 * - `not_configured`   — no client was built (credentials absent); the transport is null
 * - `auth_failed`      — the service account could not mint a token (bad or revoked key)
 * - `not_found`        — no presentation with that id, or the id is malformed
 * - `permission_denied`— the deck exists but is not shared with the service account
 * - `api_error`        — anything else Slides reported, including rate limits and 5xx
 */
export type SlidesErrorReason = "not_configured" | "auth_failed" | "not_found" | "permission_denied" | "api_error";

export interface SlidesError {
  ok: false;
  reason: SlidesErrorReason;
  message: string;
}

export type SlidesResult<T> = { ok: true; data: T } | SlidesError;

/** The subset of a presentation this stage reads. Slides returns far more; this is what we use. */
export interface Presentation {
  presentationId: string;
  /** Page dimensions, in EMU once normalised. Used by the validator to check the 1080x1080 setup. */
  pageSize?: { width?: Dimension; height?: Dimension };
  slides: Slide[];
}

export interface Dimension {
  magnitude?: number;
  unit?: string;
}

export interface Slide {
  objectId: string;
  pageElements?: PageElement[];
}

export interface PageElement {
  objectId: string;
  shape?: {
    text?: {
      textElements?: { textRun?: { content?: string } }[];
    };
  };
}

/** A Slides batchUpdate request. Left as an open shape: the stage builds these, not this module. */
export type SlidesRequest = Record<string, unknown>;

export interface SlidesTransport {
  /** Read a presentation's structure — slides, page elements, and their text. */
  getPresentation(presentationId: string): Promise<SlidesResult<Presentation>>;
  /** Apply a batch of edits. Returns nothing useful beyond success; callers re-read if they must. */
  batchUpdate(presentationId: string, requests: SlidesRequest[]): Promise<SlidesResult<void>>;
  /**
   * Export one page as PNG bytes.
   *
   * The Slides API answers with a `contentUrl` that lives only 30 minutes, so this method follows
   * it and returns the BYTES rather than the URL. Nothing time-limited may escape this boundary:
   * FR-024 wants the archive readable years later, and a caller handed a URL would eventually
   * persist it.
   */
  getPageThumbnail(presentationId: string, pageObjectId: string): Promise<SlidesResult<Uint8Array>>;
}

export interface SlidesConfig {
  serviceAccountEmail: string;
  /** Base64-encoded PEM. See the note in src/worker/env.ts for why it is not raw. */
  privateKeyBase64: string;
}

function fail(reason: SlidesErrorReason, message: string): SlidesError {
  return { ok: false, reason, message };
}

/** Maps an HTTP status onto the reason taxonomy so callers never branch on numbers. */
function reasonForStatus(status: number): SlidesErrorReason {
  if (status === 401) return "auth_failed";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  return "api_error";
}

/**
 * Decode the base64 private key back to PEM.
 *
 * Accepts either a base64-encoded PEM or a base64-encoded service-account JSON file, because the
 * operator will be holding the JSON Google hands them and encoding the whole thing is the obvious
 * move. Guessing right here is cheaper than a support round trip over a confusing auth error.
 */
export function decodePrivateKey(privateKeyBase64: string): SlidesResult<string> {
  let decoded: string;
  try {
    decoded = Buffer.from(privateKeyBase64, "base64").toString("utf8");
  } catch {
    return fail("auth_failed", "GOOGLE_SA_PRIVATE_KEY_B64 is not valid base64");
  }

  const trimmed = decoded.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const key = (parsed as { private_key?: unknown }).private_key;
      if (typeof key === "string" && key.includes("PRIVATE KEY")) return { ok: true, data: key };
      return fail("auth_failed", "the decoded service-account JSON has no `private_key` field");
    } catch {
      return fail("auth_failed", "the decoded value looks like JSON but does not parse");
    }
  }

  if (!trimmed.includes("PRIVATE KEY")) {
    return fail("auth_failed", "the decoded value is neither a PEM private key nor service-account JSON");
  }
  return { ok: true, data: trimmed };
}

/**
 * Build a Slides transport. Returns null when config is absent — the createLlmClient /
 * createEmailClient precedent — so the caller surfaces `not_configured` instead of letting an auth
 * error escape into an unattended run.
 *
 * A malformed key also yields null rather than throwing: `npm run visuals` must fail with the
 * stage's own diagnostic, not a stack trace out of the auth library.
 */
export function createSlidesClient(config: SlidesConfig | null): SlidesTransport | null {
  if (!config) return null;

  const key = decodePrivateKey(config.privateKeyBase64);
  if (!key.ok) return null;

  const auth = new JWT({ email: config.serviceAccountEmail, key: key.data, scopes: [SLIDES_SCOPE] });
  return buildTransport(auth, fetch);
}

/**
 * Split out from createSlidesClient so the request/response handling can be unit-tested against a
 * fake authorizer and a fake fetch, without a service-account key or a network.
 */
export function buildTransport(
  auth: { getRequestHeaders(url?: string): Promise<Headers | Record<string, string>> },
  fetchImpl: typeof fetch,
): SlidesTransport {
  async function authorizedFetch(url: string, init: RequestInit = {}): Promise<SlidesResult<Response>> {
    let headers: Headers | Record<string, string>;
    try {
      headers = await auth.getRequestHeaders(url);
    } catch (error) {
      return fail("auth_failed", error instanceof Error ? error.message : String(error));
    }

    // Merge through Headers rather than object spread: HeadersInit may be an array of pairs, which
    // spreads into numeric indices and silently drops every header.
    const merged = new Headers(headers);
    for (const [name, value] of new Headers(init.headers).entries()) merged.set(name, value);

    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers: merged });
    } catch (error) {
      return fail("api_error", error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      // Slides puts a human-readable explanation in the body; surfacing it is the difference
      // between "403" and "the deck is not shared with the service account".
      const body = await response.text().catch(() => "");
      return fail(reasonForStatus(response.status), `${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
    }
    return { ok: true, data: response };
  }

  return {
    async getPresentation(presentationId) {
      const result = await authorizedFetch(`${SLIDES_API}/${encodeURIComponent(presentationId)}`);
      if (!result.ok) return result;
      try {
        // Typed as the raw wire shape, with `slides` optional: this is unvalidated API output, and
        // asserting the domain type here would let a missing field through as a phantom array.
        const json = (await result.data.json()) as Omit<Presentation, "slides"> & { slides?: Presentation["slides"] };
        return { ok: true, data: { ...json, slides: json.slides ?? [] } };
      } catch (error) {
        return fail("api_error", `presentation response was not JSON: ${String(error)}`);
      }
    },

    async batchUpdate(presentationId, requests) {
      // An empty batch is a no-op the API would reject; treat it as trivially successful so
      // callers need no special case for "nothing to change on this page".
      if (requests.length === 0) return { ok: true, data: undefined };

      const result = await authorizedFetch(`${SLIDES_API}/${encodeURIComponent(presentationId)}:batchUpdate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests }),
      });
      if (!result.ok) return result;
      return { ok: true, data: undefined };
    },

    async getPageThumbnail(presentationId, pageObjectId) {
      // LARGE is 1600px on the constrained edge — the largest the API offers, and comfortably
      // above the 1080x1080 the templates are designed at.
      const url =
        `${SLIDES_API}/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}/thumbnail` +
        `?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=LARGE`;

      const meta = await authorizedFetch(url);
      if (!meta.ok) return meta;

      let contentUrl: string;
      try {
        const json = (await meta.data.json()) as { contentUrl?: string };
        if (!json.contentUrl) return fail("api_error", "thumbnail response carried no contentUrl");
        contentUrl = json.contentUrl;
      } catch (error) {
        return fail("api_error", `thumbnail response was not JSON: ${String(error)}`);
      }

      // The content URL is pre-signed and short-lived; it takes no auth header, and sending one
      // can make Google reject it. Fetch it bare.
      try {
        const image = await fetchImpl(contentUrl);
        if (!image.ok) return fail("api_error", `thumbnail download failed: ${image.status} ${image.statusText}`);
        return { ok: true, data: new Uint8Array(await image.arrayBuffer()) };
      } catch (error) {
        return fail("api_error", `thumbnail download failed: ${String(error)}`);
      }
    },
  };
}
