// SERVER-ONLY, ASTRO-SIDE. Builds the same Publisher clients Phase 4's worker builds
// (src/worker/publish.ts's buildPublishers), but reading credentials from astro:env/server
// instead of process.env -- the Astro-side twin of src/lib/supabase-admin.ts. Never import it
// from a React island, any client-reachable path, or anything under src/worker/ — the worker runs
// in plain Node, where astro:env/server does not resolve, and uses src/worker/env.ts instead.
import {
  LINKEDIN_ACCESS_TOKEN,
  LINKEDIN_ORGANIZATION_URN,
  META_ACCESS_TOKEN,
  META_IG_USER_ID,
  META_PAGE_ID,
} from "astro:env/server";

import { createFacebookPublisher } from "@/lib/publishing/facebook";
import { createInstagramPublisher } from "@/lib/publishing/instagram";
import { createLinkedinPublisher } from "@/lib/publishing/linkedin";
import type { Publisher } from "@/lib/publishing/types";
import type { SelectionPlatform } from "@/types";

/**
 * Which platform clients are usable, built from the app's own environment. Mirrors
 * src/worker/publish.ts's buildPublishers() exactly, credential-source aside, so the manual
 * "Publish now" route and the scheduled worker build identical Publisher instances.
 */
export function buildPublishers(): Partial<Record<SelectionPlatform, Publisher>> {
  const publishers: Partial<Record<SelectionPlatform, Publisher>> = {};

  const instagram = createInstagramPublisher(
    META_ACCESS_TOKEN && META_IG_USER_ID ? { accessToken: META_ACCESS_TOKEN, igUserId: META_IG_USER_ID } : null,
  );
  if (instagram) publishers.instagram = instagram;

  const facebook = createFacebookPublisher(
    META_ACCESS_TOKEN && META_PAGE_ID ? { accessToken: META_ACCESS_TOKEN, pageId: META_PAGE_ID } : null,
  );
  if (facebook) publishers.facebook = facebook;

  const linkedin = createLinkedinPublisher(
    LINKEDIN_ACCESS_TOKEN && LINKEDIN_ORGANIZATION_URN
      ? { accessToken: LINKEDIN_ACCESS_TOKEN, organizationUrn: LINKEDIN_ORGANIZATION_URN }
      : null,
  );
  if (linkedin) publishers.linkedin = linkedin;

  return publishers;
}
