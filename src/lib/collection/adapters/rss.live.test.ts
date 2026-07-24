// LIVE smoke test: fetches every enabled RSS source for real.
//
// The recorded fixtures in rss.test.ts prove the parser handles the shapes we captured.
// They cannot notice a source changing its feed format, moving its URL, or starting to
// block us — which is the failure this slice is most exposed to (FR-002 names Idealista as
// already doing it). This suite is the early warning.
//
// Opt-in via COLLECTION_LIVE_SMOKE=1, mirroring SUPABASE_TEST_PROJECT, so CI stays hermetic
// and a routine `npm test` never depends on nine third-party servers being up.
//
//   COLLECTION_LIVE_SMOKE=1 npx vitest run src/lib/collection/adapters/rss.live.test.ts
import { describe, expect, it } from "vitest";

import { rssAdapter } from "@/lib/collection/adapters/rss";
import { SOURCES } from "@/lib/collection/sources";

const enabled = SOURCES.filter((source) => source.enabled && source.tier === "rss");
const live = process.env.COLLECTION_LIVE_SMOKE === "1";

// A wide window: this asserts the feed parses, not that it published recently.
const window = {
  from: new Date(Date.now() - 90 * 86_400_000),
  to: new Date(Date.now() + 86_400_000),
};

describe.skipIf(!live)("RSS sources (live)", () => {
  it.each(enabled.map((source) => [source.slug, source] as const))(
    "%s serves a parseable feed",
    async (_slug, source) => {
      const candidates = await rssAdapter(source, window);

      expect(candidates.length).toBeGreaterThan(0);

      // Title and URL are the two fields with no fallback downstream: FR-006 scores on
      // title, and source_url is the dedupe key. A feed that parses but yields neither is
      // a silent failure worth catching here.
      const first = candidates[0];
      expect(first.title.length).toBeGreaterThan(0);
      expect(first.sourceUrl).toMatch(/^https?:\/\//);
    },
    30_000,
  );
});
