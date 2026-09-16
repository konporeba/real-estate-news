import { describe, expect, it, vi } from "vitest";

import { signAssetUrls } from "@/lib/publishing/assets";
import type { ServiceClient } from "@/lib/supabase-service";

function fakeClient(createSignedUrls: (paths: string[], ttl: number) => Promise<{ data: unknown; error: unknown }>) {
  return {
    storage: {
      from: vi.fn().mockReturnValue({ createSignedUrls }),
    },
  } as unknown as ServiceClient;
}

describe("signAssetUrls", () => {
  it("returns an empty map without calling the API when given no paths", async () => {
    const createSignedUrls = vi.fn();
    const client = fakeClient(createSignedUrls);

    const result = await signAssetUrls(client, []);

    expect(result).toEqual(new Map());
    expect(createSignedUrls).not.toHaveBeenCalled();
  });

  it("maps every signed path to its URL", async () => {
    const client = fakeClient(() =>
      Promise.resolve({
        data: [
          { path: "a.png", signedUrl: "https://signed/a", error: null },
          { path: "b.png", signedUrl: "https://signed/b", error: null },
        ],
        error: null,
      }),
    );

    const result = await signAssetUrls(client, ["a.png", "b.png"]);

    expect(result.get("a.png")).toBe("https://signed/a");
    expect(result.get("b.png")).toBe("https://signed/b");
    expect(result.size).toBe(2);
  });

  it("omits a path that failed to sign rather than throwing", async () => {
    const client = fakeClient(() =>
      Promise.resolve({
        data: [
          { path: "a.png", signedUrl: "https://signed/a", error: null },
          { path: "b.png", signedUrl: null, error: "not found" },
        ],
        error: null,
      }),
    );

    const result = await signAssetUrls(client, ["a.png", "b.png"]);

    expect(result.has("a.png")).toBe(true);
    expect(result.has("b.png")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("returns an empty map when the API call itself errors", async () => {
    const client = fakeClient(() => Promise.resolve({ data: null, error: { message: "bucket not found" } }));

    const result = await signAssetUrls(client, ["a.png"]);

    expect(result).toEqual(new Map());
  });

  it("requests the publish-specific longer TTL, not the dashboard's 10-minute default", async () => {
    const createSignedUrls = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = fakeClient(createSignedUrls);

    await signAssetUrls(client, ["a.png"]);

    const [, ttl] = createSignedUrls.mock.calls[0] as [string[], number];
    expect(ttl).toBeGreaterThan(600);
  });
});
