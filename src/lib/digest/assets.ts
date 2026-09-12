// SHARED between both runtimes, like everything else in src/lib/digest/: the worker writes the
// images, the Astro app reads them back, and neither should own the name of the place they live.
// Reads no environment and constructs no client.

/**
 * The private Storage bucket holding rendered slide images (S-06).
 *
 * Created by migration `20260908140000_visual_assets.sql`, not by code, so this is the one place
 * the name is written down in TypeScript: `SUPABASE_ASSET_BUCKET` in the worker defaults to it, and
 * the dashboard signs URLs against it.
 */
export const ASSET_BUCKET = "digest-assets";

/**
 * How long a dashboard image URL stays valid.
 *
 * The bucket is private and these URLs are minted per page render, so the TTL only has to outlive
 * the browser fetching the images on a page it has just loaded. Ten minutes is generous for that
 * and short enough that a URL copied out of the page's source is dead long before it is useful.
 */
export const SIGNED_URL_TTL_SECONDS = 600;
