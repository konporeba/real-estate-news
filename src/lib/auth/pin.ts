// F-02: PIN hashing/verification. PIN_HASH = HMAC-SHA256(key: PIN_PEPPER, message: PIN),
// generated once by scripts/hash-pin.mjs and pasted into secrets -- there is no in-app hashing
// flow since there is no sign-up. Runtime-neutral (Web Crypto only) so it works identically in
// `astro dev` (Node) and Cloudflare Workers, and is directly importable from the Node setup
// script too.
import { decodeBase64Url, encodeBase64Url } from "@/lib/auth/base64url";

async function importHmacKey(pepper: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

export async function hashPin(pin: string, pepper: string): Promise<string> {
  const key = await importHmacKey(pepper, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(pin));
  return encodeBase64Url(new Uint8Array(signature));
}

// crypto.subtle.verify does the signature comparison in constant time, so recomputing and
// verifying (rather than hashing both sides and comparing strings by hand) is what keeps this
// resistant to timing attacks without a hand-rolled constant-time compare.
export async function verifyPin(pin: string, pepper: string, storedHashBase64url: string): Promise<boolean> {
  const key = await importHmacKey(pepper, "verify");
  const signature = decodeBase64Url(storedHashBase64url);
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(pin));
}
