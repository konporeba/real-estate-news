// WORKER-SIDE configuration. The configured source list (FR-001) and its per-source
// collection method (FR-002). Sources are code-shaped config rather than a database
// table: adding one is a reviewable diff, not a migration, and the data model
// deliberately has no source entity.
//
// Every feed URL below was verified against the live source on the date in its `note` —
// most on 2026-07-24, several re-verified/replaced 2026-07-31 in favor of feeds actually
// scoped to real estate rather than a whole "Economía" section (the rubric's topic gate
// discards off-topic economy news anyway, so a scoped feed avoids paying clustering/scoring
// cost on content that was always going to be thrown away). Do not add a source without
// checking that its feed actually parses; Cinco Días and El Economista block outright and
// are recorded here as disabled rather than silently omitted. Idealista was long assumed
// feedless (`/news/rss` and `/news/feed` both 404) until 2026-07-31 found its taxonomy-scoped
// feed working — check a site's actual `<link rel="alternate">` tags, not just guessed paths.
import { z } from "zod";

/** Tier order from FR-002: a structured feed first, an API second, a rendered fetch last. */
export const SOURCE_TIERS = ["rss", "api", "rendered"] as const;

/**
 * `primary` sources are collected every run. `fallback` sources are added only when the
 * primary pool comes in under MIN_POOL_SIZE (FR-003), keeping normal-week request volume
 * down on sources that may start blocking.
 */
export const SOURCE_ROLES = ["primary", "fallback"] as const;

/**
 * Publication language. FR-013 specifies the translation stage as Spanish → Polish. The
 * operator widened that scope on 2026-07-24 (roadmap OQ#1) to include Catalan via Ara and
 * Nació Digital, then reversed that decision on 2026-07-31 in favor of a real-estate-scoped,
 * Spanish-language source list (see those two sources' notes below) — `ca` stays a valid
 * value (disabled sources still carry it, and it may return) but no enabled source uses it
 * today.
 */
export const SOURCE_LANGUAGES = ["es", "ca"] as const;

const sourceSchema = z.object({
  /** Stable key used in `collection_report`; never renamed once a run has recorded it. */
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be kebab-case"),
  name: z.string().min(1),
  tier: z.enum(SOURCE_TIERS),
  role: z.enum(SOURCE_ROLES),
  language: z.enum(SOURCE_LANGUAGES),
  url: z.url(),
  enabled: z.boolean(),
  /** Why a source is disabled, or anything else the next reader needs. */
  note: z.string().optional(),
});

export type SourceDefinition = z.infer<typeof sourceSchema>;
export type SourceTier = (typeof SOURCE_TIERS)[number];
export type SourceRole = (typeof SOURCE_ROLES)[number];

const sourceListSchema = z.array(sourceSchema).superRefine((sources, ctx) => {
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.slug)) {
      ctx.addIssue({ code: "custom", message: `duplicate source slug: ${source.slug}` });
    }
    seen.add(source.slug);
  }
});

/**
 * Minimum candidate pool before fallback sources are added (FR-003). The shortlist keeps
 * the top 15 clusters (FR-008), so the pool has to exceed that by enough for clustering
 * to have anything to choose between. This is an opening guess — revise once several real
 * weeks have been observed.
 */
export const MIN_POOL_SIZE = 20;

/** Per-source item cap. Bounds memory, insert size, and the reach of an undated item. */
export const MAX_ITEMS_PER_SOURCE = 50;

export const SOURCES: SourceDefinition[] = sourceListSchema.parse([
  // --- Real-estate-scoped primary sources (narrowed 2026-07-31 from whole-section
  //     "Economía" feeds — see the file header note on why). ---
  {
    slug: "expansion-inmobiliario",
    name: "Expansión — Inmobiliario",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://e00-expansion.uecdn.es/rss/inmobiliario.xml",
    enabled: true,
    note: "Verified 2026-07-24: 57 items. Real-estate specific.",
  },
  {
    slug: "expansion-empresas-inmobiliario",
    name: "Expansión — Empresas Inmobiliario",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://e01-expansion.uecdn.es/rss/empresas/inmobiliario.xml",
    enabled: true,
    note:
      "Verified 2026-07-31: 50 items. Real-estate-company-themed (a different feed/CDN path from " +
      "expansion-inmobiliario above, not a duplicate); some non-real-estate company news mixed in.",
  },
  {
    slug: "elpais-vivienda",
    name: "El País — Vivienda",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://elpais.com/rss/economia/vivienda.xml",
    enabled: true,
    note:
      "Verified 2026-07-31: 25 items, real-estate specific. Replaces the former elpais-economia " +
      "(whole Economía section, 39 items, mostly off-topic for this rubric) discovered by checking " +
      'the vivienda page\'s own <link rel="alternate"> tag rather than the section-level feed.',
  },
  {
    slug: "idealista-inmobiliario",
    name: "Idealista — Inmobiliario",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://www.idealista.com/news/taxonomy/term/60493/feed",
    enabled: true,
    note:
      "Verified 2026-07-31: 15 items, real-estate specific (some noise: hotel expansion, A/C coverage). " +
      "Long assumed feedless (see file header) — /news/rss and /news/feed 404, but this taxonomy-scoped " +
      'feed, discovered via the /news/inmobiliario page\'s <link rel="alternate"> tag, works and is not ' +
      "behind the bot-blocking that stopped fotocasa-blog below. Previously disabled as `idealista-news`.",
  },
  {
    slug: "fotocasa-prensa",
    name: "Fotocasa — Prensa",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://prensa.fotocasa.es/feed/",
    enabled: true,
    note:
      "Verified 2026-07-31: 5 items, real-estate specific (rental prices, agency data) — low volume but " +
      "clean signal. A different Fotocasa property from fotocasa-blog below (prensa. subdomain, not " +
      "blocked the way the blog is).",
  },

  // --- Fallback: added only when the primary pool is thin (FR-003) ---
  {
    slug: "20minutos-vivienda",
    name: "20 Minutos — Vivienda",
    tier: "rss",
    role: "fallback",
    language: "es",
    url: "https://www.20minutos.es/rss/vivienda/",
    enabled: true,
    note: "Verified 2026-07-24: 26 items. Housing-specific but lighter-weight coverage.",
  },
  {
    slug: "fotocasa-blog",
    name: "Fotocasa Life",
    tier: "rendered",
    role: "fallback",
    language: "es",
    url: "https://www.fotocasa.es/fotocasa-life/feed/",
    enabled: false,
    note:
      "Worked 2026-07-24 morning at /blog/feed/, then began blocking the same day — caught by the live " +
      "smoke test. /blog/feed/ now 301s to /fotocasa-life/feed/ (URL updated above), which serves 200 to a " +
      "browser User-Agent and 403 to ours. Deliberately NOT worked around by spoofing a browser: this is the " +
      "same bot protection Idealista's own /news/ page used to trip on, and FR-002 treats that as a tier " +
      "problem, not something to evade. Retiered to `rendered` accordingly.",
  },

  // --- Dropped 2026-07-31: general "Economía" section feeds and Catalan-language coverage.
  //     Kept here disabled (not deleted) per this file's own convention of recording why a
  //     candidate isn't in the active list. ---
  {
    slug: "lavanguardia-economia",
    name: "La Vanguardia — Economía",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://www.lavanguardia.com/rss/economia.xml",
    enabled: false,
    note:
      "Verified working 2026-07-24: 100 items. Disabled 2026-07-31 — whole Economía section, not " +
      "real-estate scoped; the rubric's topic gate would discard most of it anyway, at full clustering/" +
      "scoring cost. No real-estate-specific feed found for this outlet.",
  },
  {
    slug: "elperiodico-economia",
    name: "El Periódico — Economía",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://www.elperiodico.com/es/rss/economia/rss.xml",
    enabled: false,
    note: "Verified working 2026-07-24: 50 items. Disabled 2026-07-31 — same reason as lavanguardia-economia.",
  },
  {
    slug: "expansion-economia",
    name: "Expansión — Economía",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://e00-expansion.uecdn.es/rss/economia.xml",
    enabled: false,
    note:
      "Verified working 2026-07-24: 49 items. Disabled 2026-07-31 — whole Economía section, superseded " +
      "by this outlet's two real-estate-scoped feeds above (expansion-inmobiliario, " +
      "expansion-empresas-inmobiliario).",
  },
  {
    slug: "ara-economia",
    name: "Ara — Economia",
    tier: "rss",
    role: "primary",
    language: "ca",
    url: "https://www.ara.cat/rss/economia",
    enabled: false,
    note:
      "Verified working 2026-07-24: 45 items. Enabled 2026-07-24 (roadmap OQ#1) for Catalonia-language " +
      "coverage; disabled 2026-07-31 by operator decision dropping Catalan-language sources in favor of " +
      "a real-estate-scoped, Spanish-language list. Also whole Economía section, not real-estate scoped.",
  },
  {
    slug: "naciodigital-economia",
    name: "Nació Digital — Economia",
    tier: "rss",
    role: "primary",
    language: "ca",
    url: "https://www.naciodigital.cat/rss/economia",
    enabled: false,
    note: "Verified working 2026-07-24: 25 items. Disabled 2026-07-31 — same reason as ara-economia.",
  },

  // --- Blocked or feedless: recorded so nobody re-discovers them the hard way ---
  {
    slug: "cincodias-portada",
    name: "Cinco Días — Portada",
    tier: "api",
    role: "primary",
    language: "es",
    url: "https://feeds.elpais.com/mrss-s/pages/cincodias/site/cincodias.elpais.com/portada",
    enabled: false,
    note: "Feed URL returns 403 (2026-07-24). Reachable only via an aggregator; needs the api tier.",
  },
  {
    slug: "eleconomista-vivienda",
    name: "El Economista — Vivienda",
    tier: "api",
    role: "primary",
    language: "es",
    url: "https://www.eleconomista.es/rss/rss-category.php?category=vivienda",
    enabled: false,
    note:
      "Feed URL returns 403 (2026-07-24, re-confirmed 2026-07-31 along with three other El Economista " +
      "section pages — all 403). Needs the api tier.",
  },
]);

/** Enabled sources for a role, in configuration order. */
export function sourcesForRole(role: SourceRole, sources: SourceDefinition[] = SOURCES): SourceDefinition[] {
  return sources.filter((source) => source.enabled && source.role === role);
}
