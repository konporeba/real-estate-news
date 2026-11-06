// Publishing's safety switch. Real posting is opt-in: unless PUBLISHING_ENABLED is exactly "true",
// both publish paths use these test publishers, which contact no social network, and the real
// clients are never built. Opt-in rather than opt-out so a forgotten setting can never post, even
// where the platform credentials are present. Shared by both runtimes; reads no environment itself.
import type { Publisher } from "@/lib/publishing/types";
import type { SelectionPlatform } from "@/types";

const TEST_POST_PREFIX = "test-";

/** Only the exact string "true" turns real posting on. */
export function publishingEnabled(value: string | undefined): boolean {
  return value === "true";
}

/** Whether a recorded post id came from a test publisher, so nothing was really posted. */
export function isTestPostId(postId: string | null): boolean {
  return postId?.startsWith(TEST_POST_PREFIX) ?? false;
}

function createTestPublisher(platform: SelectionPlatform): Publisher {
  return {
    publish: () => Promise.resolve({ ok: true, postId: `${TEST_POST_PREFIX}${platform}-${String(Date.now())}` }),
  };
}

export function testPublishers(): Record<SelectionPlatform, Publisher> {
  return {
    instagram: createTestPublisher("instagram"),
    facebook: createTestPublisher("facebook"),
    linkedin: createTestPublisher("linkedin"),
  };
}
