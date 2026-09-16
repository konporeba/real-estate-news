// Shared low-level HTTP helpers for Meta's Graph API. Instagram and Facebook posting (Phase 2's
// instagram.ts/facebook.ts) both speak this same API, with the same auth, request, and error-body
// shape — only the endpoints and request sequencing differ, which is what those two modules own.
//
// **Re-confirm the API version against Meta's current developer docs at implementation/dry-run
// time** — the plan's own caveat: this constant is the well-established mechanism as of planning,
// not a guarantee Meta hasn't moved the version forward since.
export const GRAPH_API_VERSION = "v21.0";

const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type GraphResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number };
}

function errorMessage(status: number, statusText: string, body: unknown): string {
  const parsed = body as GraphErrorBody;
  if (parsed.error?.message) {
    const code = parsed.error.code === undefined ? "" : ` (code ${String(parsed.error.code)})`;
    return `Graph API error${code}: ${parsed.error.message}`;
  }
  return `Graph API error: ${String(status)} ${statusText}`;
}

export interface GraphClient {
  get(path: string, params?: Record<string, string>): Promise<GraphResult<Record<string, unknown>>>;
  post(path: string, params: Record<string, string>): Promise<GraphResult<Record<string, unknown>>>;
}

/** Build a Graph API client bound to one access token. Never throws — every failure is a `GraphResult`. */
export function createGraphClient(fetchImpl: typeof fetch, accessToken: string): GraphClient {
  function withToken(params: Record<string, string>): Record<string, string> {
    return { ...params, access_token: accessToken };
  }

  async function request(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string>,
  ): Promise<GraphResult<Record<string, unknown>>> {
    let response: Response;
    try {
      if (method === "GET") {
        const url = new URL(`${GRAPH_API_BASE}/${path}`);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        response = await fetchImpl(url.toString());
      } else {
        response = await fetchImpl(`${GRAPH_API_BASE}/${path}`, { method: "POST", body: new URLSearchParams(params) });
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    let json: unknown = {};
    try {
      json = await response.json();
    } catch {
      // A non-JSON body on failure is still reported via the status line below; a non-JSON body
      // on success (unexpected for this API) surfaces as an empty object to the caller.
    }

    if (!response.ok) return { ok: false, error: errorMessage(response.status, response.statusText, json) };
    return { ok: true, data: json as Record<string, unknown> };
  }

  return {
    get: (path, params = {}) => request("GET", path, withToken(params)),
    post: (path, params) => request("POST", path, withToken(params)),
  };
}
