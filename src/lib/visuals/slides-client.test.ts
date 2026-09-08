import { describe, expect, it, vi } from "vitest";

import {
  buildTransport,
  createSlidesClient,
  decodePrivateKey,
  type SlidesTransport,
} from "@/lib/visuals/slides-client";

// A syntactically plausible PEM. Never used to sign anything — createSlidesClient is only checked
// for the null/non-null decision, which happens before any network or crypto work.
const FAKE_PEM = "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADAN\n-----END PRIVATE KEY-----\n";
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

/** Stands in for google-auth-library's JWT: the transport only ever asks it for headers. */
const fakeAuth = (headers: Record<string, string> = { authorization: "Bearer test-token" }) => ({
  getRequestHeaders: vi.fn().mockResolvedValue(headers),
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("decodePrivateKey", () => {
  it("accepts a base64-encoded PEM", () => {
    const result = decodePrivateKey(b64(FAKE_PEM));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toContain("PRIVATE KEY");
  });

  // The operator is holding the JSON file Google hands them; encoding the whole thing is the
  // obvious move, so it must work rather than producing a confusing auth error later.
  it("accepts a base64-encoded service-account JSON file", () => {
    const result = decodePrivateKey(b64(JSON.stringify({ type: "service_account", private_key: FAKE_PEM })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(FAKE_PEM);
  });

  it("rejects JSON with no private_key field", () => {
    const result = decodePrivateKey(b64(JSON.stringify({ type: "service_account" })));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("auth_failed");
    expect(result.message).toMatch(/private_key/);
  });

  it("rejects a value that decodes to neither PEM nor JSON", () => {
    const result = decodePrivateKey(b64("just some text"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("auth_failed");
  });
});

describe("createSlidesClient", () => {
  it("returns null when config is absent, so the caller reports not_configured", () => {
    expect(createSlidesClient(null)).toBeNull();
  });

  // A bad key must not throw: an unattended run has to fail with the stage's own diagnostic,
  // not a stack trace out of the auth library.
  it("returns null rather than throwing on an undecodable key", () => {
    expect(createSlidesClient({ serviceAccountEmail: "sa@example.com", privateKeyBase64: b64("nonsense") })).toBeNull();
  });
});

describe("getPresentation", () => {
  it("returns the parsed presentation and defaults slides to an array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ presentationId: "deck-1" }));
    const slides: SlidesTransport = buildTransport(fakeAuth(), fetchImpl);

    const result = await slides.getPresentation("deck-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.presentationId).toBe("deck-1");
    expect(result.data.slides).toEqual([]);
  });

  it("sends the authorization header the authorizer supplies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ presentationId: "deck-1", slides: [] }));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    await slides.getPresentation("deck-1");

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
  });

  it.each([
    [401, "auth_failed"],
    [403, "permission_denied"],
    [404, "not_found"],
    [429, "api_error"],
    [500, "api_error"],
  ])("maps HTTP %i onto %s", async (status, reason) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("denied", { status, statusText: "x" }));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    const result = await slides.getPresentation("deck-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
  });

  // "403" alone sends the operator hunting; the body says which deck is not shared.
  it("carries the API's own explanation into the message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("The caller does not have permission", { status: 403 }));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    const result = await slides.getPresentation("deck-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/does not have permission/);
  });

  it("reports auth_failed when the token cannot be minted", async () => {
    const auth = { getRequestHeaders: vi.fn().mockRejectedValue(new Error("invalid_grant")) };
    const slides = buildTransport(auth, vi.fn());

    const result = await slides.getPresentation("deck-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("auth_failed");
    expect(result.message).toMatch(/invalid_grant/);
  });

  it("reports api_error when the network itself fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    const result = await slides.getPresentation("deck-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("api_error");
  });
});

describe("batchUpdate", () => {
  it("posts the requests to the batchUpdate endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    const result = await slides.batchUpdate("deck-1", [{ deleteObject: { objectId: "p1" } }]);

    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(":batchUpdate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ requests: [{ deleteObject: { objectId: "p1" } }] });
  });

  // The API rejects an empty batch. Callers build request lists per page and some pages legitimately
  // need no changes, so absorbing it here keeps that special case out of every call site.
  it("treats an empty batch as a no-op without calling the API", async () => {
    const fetchImpl = vi.fn();
    const slides = buildTransport(fakeAuth(), fetchImpl);

    const result = await slides.batchUpdate("deck-1", []);

    expect(result.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("getPageThumbnail", () => {
  it("follows the contentUrl and returns the bytes, not the URL", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ contentUrl: "https://lh3.example/img" }))
      .mockResolvedValueOnce(new Response(png, { status: 200 }));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    const result = await slides.getPageThumbnail("deck-1", "page-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.data]).toEqual([...png]);
  });

  it("requests a PNG at LARGE, the largest size the API offers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ contentUrl: "https://lh3.example/img" }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    await slides.getPageThumbnail("deck-1", "page-1");

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("thumbnailProperties.mimeType=PNG");
    expect(url).toContain("thumbnailProperties.thumbnailSize=LARGE");
  });

  // The content URL is pre-signed; attaching an Authorization header can make Google reject it.
  it("fetches the content URL without auth headers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ contentUrl: "https://lh3.example/img" }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    await slides.getPageThumbnail("deck-1", "page-1");

    expect(fetchImpl.mock.calls[1]).toEqual(["https://lh3.example/img"]);
  });

  it("reports api_error when the response carries no contentUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    const result = await slides.getPageThumbnail("deck-1", "page-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/contentUrl/);
  });

  it("reports api_error when the image download fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ contentUrl: "https://lh3.example/img" }))
      .mockResolvedValueOnce(new Response("gone", { status: 404, statusText: "Not Found" }));
    const slides = buildTransport(fakeAuth(), fetchImpl);

    const result = await slides.getPageThumbnail("deck-1", "page-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("api_error");
    expect(result.message).toMatch(/download failed/);
  });
});
