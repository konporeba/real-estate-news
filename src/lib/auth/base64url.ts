// Shared by pin.ts and session.ts, both of which need to turn Web Crypto's raw signature bytes
// into a string safe for an env var / cookie value, and back. `btoa`/`atob` are standard Web
// Crypto-adjacent globals available identically in Node (astro dev) and Cloudflare Workers, so
// this needs no runtime branching and no new dependency.

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
