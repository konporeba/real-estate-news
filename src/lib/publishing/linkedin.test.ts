import { describe, expect, it, vi } from "vitest";

import { buildLinkedinPublisher, createLinkedinPublisher } from "@/lib/publishing/linkedin";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

const credentials = { accessToken: "token-1", organizationUrn: "urn:li:organization:123" };

describe("createLinkedinPublisher", () => {
  it("returns null when credentials are absent", () => {
    expect(createLinkedinPublisher(null)).toBeNull();
  });
});

describe("buildLinkedinPublisher", () => {
  it("registers a single image (initialize, download, upload) then posts, returning the id header", async () => {
    const imageBytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: { uploadUrl: "https://upload/1", image: "urn:li:image:1" } })) // initializeUpload
      .mockResolvedValueOnce(new Response(imageBytes, { status: 200 })) // download source image
      .mockResolvedValueOnce(new Response(null, { status: 201 })) // PUT upload
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { "x-restli-id": "post-1" } })); // create post
    const publisher = buildLinkedinPublisher(credentials, fetchImpl);

    const result = await publisher.publish(["https://signed/a.png"], "caption text");

    expect(result).toEqual({ ok: true, postId: "post-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const [initUrl, initInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(initUrl).toContain("images?action=initializeUpload");
    expect(JSON.parse(initInit.body as string)).toEqual({
      initializeUploadRequest: { owner: credentials.organizationUrn },
    });

    const [uploadUrl, uploadInit] = fetchImpl.mock.calls[2] as [string, RequestInit];
    expect(uploadUrl).toBe("https://upload/1");
    expect(uploadInit.method).toBe("PUT");
    expect(uploadInit.headers).toBeUndefined();

    const [postUrl, postInit] = fetchImpl.mock.calls[3] as [string, RequestInit];
    expect(postUrl).toContain("/posts");
    const body = JSON.parse(postInit.body as string) as { content: { multiImage: { images: { id: string }[] } } };
    expect(body.content.multiImage.images).toEqual([{ id: "urn:li:image:1" }]);
  });

  it("registers every image before creating one post referencing all of them", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: { uploadUrl: "https://upload/1", image: "urn:li:image:1" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ value: { uploadUrl: "https://upload/2", image: "urn:li:image:2" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { "x-restli-id": "post-2" } }));
    const publisher = buildLinkedinPublisher(credentials, fetchImpl);

    const result = await publisher.publish(["https://signed/a.png", "https://signed/b.png"], "carousel caption");

    expect(result).toEqual({ ok: true, postId: "post-2" });
    const [, postInit] = fetchImpl.mock.calls[6] as [string, RequestInit];
    const body = JSON.parse(postInit.body as string) as { content: { multiImage: { images: { id: string }[] } } };
    expect(body.content.multiImage.images).toEqual([{ id: "urn:li:image:1" }, { id: "urn:li:image:2" }]);
  });

  it("returns an error without throwing when given no images", async () => {
    const publisher = buildLinkedinPublisher(credentials, vi.fn());

    const result = await publisher.publish([], "caption");

    expect(result).toEqual({ ok: false, error: "no images to publish" });
  });

  it("fails without registering further images when initializeUpload fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403, statusText: "Forbidden" }));
    const publisher = buildLinkedinPublisher(credentials, fetchImpl);

    const result = await publisher.publish(["https://signed/a.png", "https://signed/b.png"], "caption");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("403");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails when the post response carries no x-restli-id header", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: { uploadUrl: "https://upload/1", image: "urn:li:image:1" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const publisher = buildLinkedinPublisher(credentials, fetchImpl);

    const result = await publisher.publish(["https://signed/a.png"], "caption");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("x-restli-id");
  });
});
