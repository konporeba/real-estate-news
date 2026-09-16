import { describe, expect, it, vi } from "vitest";

import { createGraphClient } from "@/lib/publishing/graph-api";
import {
  buildInstagramPublisher,
  createInstagramPublisher,
  INSTAGRAM_MAX_CAPTION_LENGTH,
} from "@/lib/publishing/instagram";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

const noSleep = () => Promise.resolve();

describe("createInstagramPublisher", () => {
  it("returns null when credentials are absent", () => {
    expect(createInstagramPublisher(null)).toBeNull();
  });
});

describe("buildInstagramPublisher", () => {
  it("publishes a single image: create container, poll to FINISHED, then publish", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "container-1" })) // create container
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" })) // poll
      .mockResolvedValueOnce(jsonResponse({ id: "media-1" })); // media_publish
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildInstagramPublisher("ig-user-1", client, noSleep);

    const result = await publisher.publish(["https://signed/a.png"], "caption text");

    expect(result).toEqual({ ok: true, postId: "media-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("polls IN_PROGRESS -> FINISHED before publishing", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "container-1" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "IN_PROGRESS" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "IN_PROGRESS" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "media-1" }));
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildInstagramPublisher("ig-user-1", client, sleep);

    const result = await publisher.publish(["https://signed/a.png"], "caption");

    expect(result).toEqual({ ok: true, postId: "media-1" });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails the platform, not the run, when polling exhausts its budget", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/media")) return Promise.resolve(jsonResponse({ id: "container-1" }));
      return Promise.resolve(jsonResponse({ status_code: "IN_PROGRESS" }));
    });
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildInstagramPublisher("ig-user-1", client, noSleep);

    const result = await publisher.publish(["https://signed/a.png"], "caption");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("did not finish processing");
  });

  it("fails when a container reports status_code=ERROR", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "container-1" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "ERROR" }));
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildInstagramPublisher("ig-user-1", client, noSleep);

    const result = await publisher.publish(["https://signed/a.png"], "caption");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ERROR");
  });

  it("publishes a carousel: one child container per image, then a parent, then publish", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "child-1" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "child-2" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "parent-1" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "media-carousel" }));
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildInstagramPublisher("ig-user-1", client, noSleep);

    const result = await publisher.publish(["https://signed/a.png", "https://signed/b.png"], "carousel caption");

    expect(result).toEqual({ ok: true, postId: "media-carousel" });

    const parentCreateCall = fetchImpl.mock.calls[4] as [string, RequestInit];
    const body = new URLSearchParams(parentCreateCall[1].body as string);
    expect(body.get("media_type")).toBe("CAROUSEL");
    expect(body.get("children")).toBe("child-1,child-2");
  });

  it("returns an error without throwing when given no images", async () => {
    const client = createGraphClient(vi.fn(), "token");
    const publisher = buildInstagramPublisher("ig-user-1", client, noSleep);

    const result = await publisher.publish([], "caption");

    expect(result).toEqual({ ok: false, error: "no images to publish" });
  });

  it("surfaces a Graph API error from container creation without publishing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "Invalid image URL", code: 100 } }, { status: 400 }));
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildInstagramPublisher("ig-user-1", client, noSleep);

    const result = await publisher.publish(["https://signed/bad.png"], "caption");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid image URL");
  });

  it("truncates the caption to Instagram's own limit before creating the container", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "container-1" }))
      .mockResolvedValueOnce(jsonResponse({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonResponse({ id: "media-1" }));
    const client = createGraphClient(fetchImpl, "token");
    const publisher = buildInstagramPublisher("ig-user-1", client, noSleep);
    const overLong = "word ".repeat(1000);

    await publisher.publish(["https://signed/a.png"], overLong);

    const [, createInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(createInit.body as string);
    expect(body.get("caption")?.length).toBeLessThanOrEqual(INSTAGRAM_MAX_CAPTION_LENGTH);
  });
});
