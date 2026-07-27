// F-02: stateless signed session cookie -- no session table, no DB read per authenticated
// request. Token shape: `<base64url(JSON {exp})>.<base64url(HMAC-SHA256 signature over that
// segment))>`. Runtime-neutral (Web Crypto only), same HMAC-SHA256-via-crypto.subtle.verify
// pattern as src/lib/auth/pin.ts so both PIN checking and session verification share one
// constant-time comparison primitive.
import { decodeBase64Url, encodeBase64Url } from "@/lib/auth/base64url";

/** Shared by verify-pin.ts (sets it) and middleware.ts (reads it) so the name lives in one place. */
export const SESSION_COOKIE_NAME = "operator_session";

/** ~30 days -- matches the weekly usage pattern; re-entering a PIN every visit is friction the
 * product exists to shrink, not a security requirement for a single operator's own device. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

async function importHmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

export async function createSessionToken(secret: string, maxAgeSeconds: number): Promise<string> {
  const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + maxAgeSeconds });
  const payloadSegment = encodeBase64Url(new TextEncoder().encode(payload));

  const key = await importHmacKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadSegment));

  return `${payloadSegment}.${encodeBase64Url(new Uint8Array(signature))}`;
}

// The token comes from a request cookie -- attacker-controlled input -- so, unlike pin.ts's
// env-sourced hash, malformed input here (bad base64, truncated token, non-JSON payload) is an
// expected case handled by returning false rather than throwing.
export async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadSegment, signatureSegment] = parts;

  try {
    const key = await importHmacKey(secret, "verify");
    const signature = decodeBase64Url(signatureSegment);
    const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(payloadSegment));
    if (!valid) return false;

    const payload: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadSegment)));
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === "number" && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}
