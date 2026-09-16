import { describe, expect, it, vi } from "vitest";

import { buildFacebookPublisher, createFacebookPublisher } from "@/lib/publishing/facebook";
import { createGraphClient } from "@/lib/publishing/graph-api";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("createFacebookPublisher", () => {
  it("returns null when credentials are absent", () => {
    expect(createFacebookPublisher(null)).toBeNull();
  });
});

describe("buildFacebookPublisher", () => {
  it("publishes a single image: upload the photo unpublished, then post to the feed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "photo-1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "post-1" }));
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildFacebookPublisher("page-1", client);

    const result = await publisher.publish(["https://signed/a.png"], "caption text");

    expect(result).toEqual({ ok: true, postId: "post-1" });

    const [photoUrl, photoInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(photoUrl).toContain("page-1/photos");
    const photoBody = new URLSearchParams(photoInit.body as string);
    expect(photoBody.get("url")).toBe("https://signed/a.png");
    expect(photoBody.get("published")).toBe("false");

    const [feedUrl, feedInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(feedUrl).toContain("page-1/feed");
    const feedBody = new URLSearchParams(feedInit.body as string);
    expect(feedBody.get("message")).toBe("caption text");
    expect(JSON.parse(feedBody.get("attached_media") ?? "[]")).toEqual([{ media_fbid: "photo-1" }]);
  });

  it("uploads every image before posting, referencing all of them in one feed post", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "photo-1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "photo-2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "post-1" }));
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildFacebookPublisher("page-1", client);

    const result = await publisher.publish(["https://signed/a.png", "https://signed/b.png"], "carousel caption");

    expect(result).toEqual({ ok: true, postId: "post-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [, feedInit] = fetchImpl.mock.calls[2] as [string, RequestInit];
    const feedBody = new URLSearchParams(feedInit.body as string);
    expect(JSON.parse(feedBody.get("attached_media") ?? "[]")).toEqual([
      { media_fbid: "photo-1" },
      { media_fbid: "photo-2" },
    ]);
  });

  it("returns an error without throwing when given no images", async () => {
    const client = createGraphClient(vi.fn(), "token");
    const publisher = buildFacebookPublisher("page-1", client);

    const result = await publisher.publish([], "caption");

    expect(result).toEqual({ ok: false, error: "no images to publish" });
  });

  it("fails without posting to the feed when a photo upload fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "Invalid URL", code: 100 } }, { status: 400 }));
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildFacebookPublisher("page-1", client);

    const result = await publisher.publish(["https://signed/bad.png"], "caption");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid URL");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
