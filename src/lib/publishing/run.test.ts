import { describe, expect, it, vi } from "vitest";

import { runPublish } from "@/lib/publishing/run";
import type { Publisher } from "@/lib/publishing/types";
import type { ServiceClient } from "@/lib/supabase-service";

interface FakeState {
  digest?: { status: string } | null;
  digestError?: { code: string; message: string } | null;
  selection?: { platforms: string[] } | null;
  selectionError?: { code: string; message: string } | null;
  publication?: { platform: string; status: string }[];
  generatedAsset?: { cluster_id: string | null; storage_path: string }[];
  generatedCopy?: { cluster_id: string; caption_summary: string }[];
  rpcImpl?: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code: string; message: string } | null }>;
}

function fakeClient(state: FakeState) {
  function eqResult(table: string): unknown {
    switch (table) {
      case "digest":
        return { maybeSingle: () => Promise.resolve({ data: state.digest ?? null, error: state.digestError ?? null }) };
      case "selection":
        return {
          maybeSingle: () => Promise.resolve({ data: state.selection ?? null, error: state.selectionError ?? null }),
        };
      case "publication":
        return Promise.resolve({ data: state.publication ?? [], error: null });
      case "generated_asset":
        return { order: () => Promise.resolve({ data: state.generatedAsset ?? [], error: null }) };
      case "generated_copy":
        return Promise.resolve({ data: state.generatedCopy ?? [], error: null });
      default:
        throw new Error(`fakeClient: unexpected table "${table}"`);
    }
  }

  return {
    from: (table: string) => ({ select: () => ({ eq: () => eqResult(table) }) }),
    storage: {
      from: () => ({
        createSignedUrls: (paths: string[]) =>
          Promise.resolve({
            data: paths.map((path) => ({ path, signedUrl: `https://signed/${path}`, error: null })),
            error: null,
          }),
      }),
    },
    rpc: state.rpcImpl ?? (() => Promise.resolve({ data: "publication-id", error: null })),
  } as unknown as ServiceClient;
}

function successPublisher(postId: string): Publisher {
  return { publish: vi.fn().mockResolvedValue({ ok: true, postId }) };
}

function failurePublisher(error: string): Publisher {
  return { publish: vi.fn().mockResolvedValue({ ok: false, error }) };
}

const BASE_ASSETS = [
  { cluster_id: null, storage_path: "cover.png" },
  { cluster_id: "cluster-1", storage_path: "slide-1.png" },
  { cluster_id: "cluster-2", storage_path: "slide-2.png" },
];
const BASE_COPY = [
  { cluster_id: "cluster-1", caption_summary: "Story one summary." },
  { cluster_id: "cluster-2", caption_summary: "Story two summary." },
];

describe("runPublish", () => {
  it("refuses a digest that was never found", async () => {
    const client = fakeClient({ digest: null });

    const result = await runPublish(client, "missing-digest", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
    expect(result.message).toContain("missing-digest");
  });

  it("refuses a digest that has not reached approval", async () => {
    const client = fakeClient({ digest: { status: "generating" } });

    const result = await runPublish(client, "digest-1", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("wrong_status");
  });

  it("returns an empty summary when there is no confirmed selection", async () => {
    const client = fakeClient({ digest: { status: "approved" }, selection: null });

    const result = await runPublish(client, "digest-1", {});

    expect(result).toEqual({ ok: true, data: [] });
  });

  it("attempts every selected platform and records success for each", async () => {
    const rpcCalls: Record<string, unknown>[] = [];
    const client = fakeClient({
      digest: { status: "approved" },
      selection: { platforms: ["instagram", "facebook"] },
      publication: [],
      generatedAsset: BASE_ASSETS,
      generatedCopy: BASE_COPY,
      rpcImpl: (_fn, args) => {
        rpcCalls.push(args);
        return Promise.resolve({ data: "id", error: null });
      },
    });
    const instagram = successPublisher("ig-post-1");
    const facebook = successPublisher("fb-post-1");

    const result = await runPublish(client, "digest-1", { instagram, facebook });

    expect(result).toEqual({
      ok: true,
      data: [
        { platform: "instagram", ok: true, postId: "ig-post-1" },
        { platform: "facebook", ok: true, postId: "fb-post-1" },
      ],
    });
    expect(rpcCalls).toEqual([
      { p_digest_id: "digest-1", p_platform: "instagram", p_status: "success", p_post_id: "ig-post-1", p_error: null },
      { p_digest_id: "digest-1", p_platform: "facebook", p_status: "success", p_post_id: "fb-post-1", p_error: null },
    ]);
  });

  // US-20: one platform failing must not block, retry, or hide the others.
  it("records one platform's failure independently of another's success", async () => {
    const client = fakeClient({
      digest: { status: "approved" },
      selection: { platforms: ["instagram", "facebook"] },
      publication: [],
      generatedAsset: BASE_ASSETS,
      generatedCopy: BASE_COPY,
    });
    const instagram = failurePublisher("rate limited");
    const facebook = successPublisher("fb-post-1");

    const result = await runPublish(client, "digest-1", { instagram, facebook });

    expect(result).toEqual({
      ok: true,
      data: [
        { platform: "instagram", ok: false, error: "rate limited" },
        { platform: "facebook", ok: true, postId: "fb-post-1" },
      ],
    });
  });

  it("only re-attempts the platform that previously failed", async () => {
    const client = fakeClient({
      digest: { status: "approved" },
      selection: { platforms: ["instagram", "facebook"] },
      publication: [{ platform: "facebook", status: "success" }],
      generatedAsset: BASE_ASSETS,
      generatedCopy: BASE_COPY,
    });
    const instagram = successPublisher("ig-post-2");
    const facebookPublish = vi.fn();
    const facebook: Publisher = { publish: facebookPublish };

    const result = await runPublish(client, "digest-1", { instagram, facebook });

    expect(result).toEqual({ ok: true, data: [{ platform: "instagram", ok: true, postId: "ig-post-2" }] });
    expect(facebookPublish).not.toHaveBeenCalled();
  });

  it("returns an empty summary when every selected platform has already succeeded", async () => {
    const client = fakeClient({
      digest: { status: "published" },
      selection: { platforms: ["instagram"] },
      publication: [{ platform: "instagram", status: "success" }],
    });

    const result = await runPublish(client, "digest-1", { instagram: successPublisher("should-not-be-called") });

    expect(result).toEqual({ ok: true, data: [] });
  });

  it("records not_configured for a selected platform with no client, without throwing", async () => {
    const rpcCalls: Record<string, unknown>[] = [];
    const client = fakeClient({
      digest: { status: "approved" },
      selection: { platforms: ["linkedin"] },
      publication: [],
      generatedAsset: BASE_ASSETS,
      generatedCopy: BASE_COPY,
      rpcImpl: (_fn, args) => {
        rpcCalls.push(args);
        return Promise.resolve({ data: "id", error: null });
      },
    });

    const result = await runPublish(client, "digest-1", {});

    expect(result).toEqual({ ok: true, data: [{ platform: "linkedin", ok: false, error: "not_configured" }] });
    expect(rpcCalls).toEqual([
      {
        p_digest_id: "digest-1",
        p_platform: "linkedin",
        p_status: "failure",
        p_post_id: null,
        p_error: "not_configured",
      },
    ]);
  });

  it("orders the caption by generated_asset.slide_index even when generated_copy rows come back in a different order", async () => {
    const client = fakeClient({
      digest: { status: "approved" },
      selection: { platforms: ["facebook"] },
      publication: [],
      generatedAsset: BASE_ASSETS,
      // Reversed relative to slide order (cluster-2 before cluster-1) -- the caption must still
      // read cluster-1 first, because it derives order from generated_asset, not this query.
      generatedCopy: [
        { cluster_id: "cluster-2", caption_summary: "Story two summary." },
        { cluster_id: "cluster-1", caption_summary: "Story one summary." },
      ],
    });
    const facebookPublish = vi.fn().mockResolvedValue({ ok: true, postId: "fb-post-1" });
    const facebook: Publisher = { publish: facebookPublish };

    await runPublish(client, "digest-1", { facebook });

    expect(facebookPublish).toHaveBeenCalledWith(
      ["https://signed/cover.png", "https://signed/slide-1.png", "https://signed/slide-2.png"],
      "Story one summary.\n\n---\n\nStory two summary.",
    );
  });

  it("surfaces record_publication's SQLSTATE distinctly when it fails mid-run", async () => {
    const client = fakeClient({
      digest: { status: "approved" },
      selection: { platforms: ["instagram"] },
      publication: [],
      generatedAsset: BASE_ASSETS,
      generatedCopy: BASE_COPY,
      rpcImpl: () => Promise.resolve({ data: null, error: { code: "PB002", message: "wrong status" } }),
    });

    const result = await runPublish(client, "digest-1", { instagram: successPublisher("ig-post-1") });

    expect(result).toEqual({ ok: false, reason: "wrong_status", message: "wrong status" });
  });
});
