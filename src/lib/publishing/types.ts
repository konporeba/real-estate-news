// SHARED between both runtimes: the worker builds publisher clients from `src/worker/env.ts`, the
// app builds them from `astro:env/server` (Phase 5), and this module reads neither — one contract,
// two credential sources, mirroring `src/lib/email/client.ts`'s split.

/** One platform-publish attempt's outcome. Mirrors `SlidesResult`/`EmailResult`'s ok/error idiom. */
export type PublishAttempt = { ok: true; postId: string } | { ok: false; error: string };

/**
 * One platform's posting capability, already bound to that platform's credentials. Every platform
 * client implements this so `runPublish` (Phase 3) never branches on which platform it is calling.
 */
export interface Publisher {
  /**
   * Post the given images (already-signed, fetchable URLs, in publish order — cover slide first
   * for a carousel) with the given caption (already composed and truncated for this platform).
   * One attempt, no retry — matches `sendEmail()`'s "no retry, fail fast" contract.
   */
  publish(images: readonly string[], caption: string): Promise<PublishAttempt>;
}
