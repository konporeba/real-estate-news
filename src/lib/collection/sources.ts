// WORKER-SIDE configuration. The configured source list (FR-001) and its per-source
// collection method (FR-002). Sources are code-shaped config rather than a database
// table: adding one is a reviewable diff, not a migration, and the data model
// deliberately has no source entity.
//
// Every feed URL below was verified against the live source on 2026-07-24 — see the
// `verified` note on each entry. Do not add a source without checking that its feed
// actually parses; three obvious candidates (Cinco Días, El Economista, Idealista) block
// or 404 and are recorded here as disabled rather than silently omitted.
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
 * Publication language. FR-013 specifies the translation stage as Spanish → Polish, but the
 * operator widened that scope on 2026-07-24 (roadmap OQ#1) to include Catalan: Ara and Nació
 * Digital are the best Catalonia coverage available, and Catalonia is exactly what the
 * geography-first rubric weights highest. S-02/S-03 must therefore handle `ca` as a source
 * language, not just `es` — the `language` field on each source is what tells them which.
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
  // --- Catalonia / Barcelona: the editorial core (rubric scores these highest) ---
  {
    slug: "lavanguardia-economia",
    name: "La Vanguardia — Economía",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://www.lavanguardia.com/rss/economia.xml",
    enabled: true,
    note: "Verified 2026-07-24: 100 items. Note the /mvc/feed/rss/ path is 410 Gone; this one works.",
  },
  {
    slug: "elperiodico-economia",
    name: "El Periódico — Economía",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://www.elperiodico.com/es/rss/economia/rss.xml",
    enabled: true,
    note: "Verified 2026-07-24: 50 items.",
  },

  // --- Spain-wide national: applies to Catalonia too, so it scores above other regions ---
  {
    slug: "expansion-inmobiliario",
    name: "Expansión — Inmobiliario",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://e00-expansion.uecdn.es/rss/inmobiliario.xml",
    enabled: true,
    note: "Verified 2026-07-24: 57 items. The only feed found that is real-estate specific.",
  },
  {
    slug: "expansion-economia",
    name: "Expansión — Economía",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://e00-expansion.uecdn.es/rss/economia.xml",
    enabled: true,
    note: "Verified 2026-07-24: 49 items.",
  },
  {
    slug: "elpais-economia",
    name: "El País — Economía",
    tier: "rss",
    role: "primary",
    language: "es",
    url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/economia/portada",
    enabled: true,
    note: "Verified 2026-07-24: 39 items.",
  },

  // --- Fallbacks: added only when the primary pool is thin (FR-003) ---
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
      "same bot protection Idealista uses, and FR-002 treats that as a tier problem, not something to evade. " +
      "Retiered to `rendered` accordingly.",
  },

  // --- Catalan-language: the closest coverage to the target audience's geography.
  //     Enabled by operator decision 2026-07-24, which widens FR-013's translation
  //     scope from es->pl to {es,ca}->pl. See the SOURCE_LANGUAGES note above.
  {
    slug: "ara-economia",
    name: "Ara — Economia",
    tier: "rss",
    role: "primary",
    language: "ca",
    url: "https://www.ara.cat/rss/economia",
    enabled: true,
    note: "Verified 2026-07-24: 45 items. Catalan-language — requires ca->pl translation in S-03.",
  },
  {
    slug: "naciodigital-economia",
    name: "Nació Digital — Economia",
    tier: "rss",
    role: "primary",
    language: "ca",
    url: "https://www.naciodigital.cat/rss/economia",
    enabled: true,
    note: "Verified 2026-07-24: 25 items. Catalan-language — requires ca->pl translation in S-03.",
  },

  // --- Blocked or feedless: recorded so nobody re-discovers them the hard way ---
  {
    slug: "idealista-news",
    name: "Idealista — News",
    tier: "rendered",
    role: "primary",
    language: "es",
    url: "https://www.idealista.com/news/",
    enabled: false,
    note: "No feed: /news/rss and /news/feed both 404 (2026-07-24). FR-002 names Idealista as actively blocking automated fetching; needs the rendered tier.",
  },
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
    note: "Feed URL returns 403 (2026-07-24). Needs the api tier.",
  },
]);

/** Enabled sources for a role, in configuration order. */
export function sourcesForRole(role: SourceRole, sources: SourceDefinition[] = SOURCES): SourceDefinition[] {
  return sources.filter((source) => source.enabled && source.role === role);
}
