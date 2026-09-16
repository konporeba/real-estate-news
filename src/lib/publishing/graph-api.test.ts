import { describe, expect, it, vi } from "vitest";

import { createGraphClient } from "@/lib/publishing/graph-api";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("createGraphClient", () => {
  it("posts params as a form body with the access token attached", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "123" }));
    const client = createGraphClient(fetchImpl, "test-token");

    const result = await client.post("me/media", { caption: "hello" });

    expect(result).toEqual({ ok: true, data: { id: "123" } });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("me/media");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("caption")).toBe("hello");
    expect(body.get("access_token")).toBe("test-token");
  });

  it("attaches the access token as a query param on GET", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status_code: "FINISHED" }));
    const client = createGraphClient(fetchImpl, "test-token");

    await client.get("container-1", { fields: "status_code" });

    const [url] = fetchImpl.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("fields")).toBe("status_code");
    expect(parsed.searchParams.get("access_token")).toBe("test-token");
  });

  it("surfaces the Graph API's own error message and code on failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "Invalid OAuth token", code: 190 } }, { status: 401 }));
    const client = createGraphClient(fetchImpl, "bad-token");

    const result = await client.post("me/media", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid OAuth token");
    expect(result.error).toContain("190");
  });

  it("falls back to the HTTP status when the body carries no Graph error shape", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("gateway timeout", { status: 504, statusText: "Gateway Timeout" }));
    const client = createGraphClient(fetchImpl, "token");

    const result = await client.post("me/media", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("504");
  });

  it("reports a network failure without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const client = createGraphClient(fetchImpl, "token");

    const result = await client.post("me/media", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ECONNRESET");
  });
});
