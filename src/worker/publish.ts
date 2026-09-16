// WORKER-SIDE ENTRYPOINT. `npm run publish` — the manual/scheduled trigger for the publishing
// stage (S-08), the process that posts an `approved` (or `skipped`) digest's rendered copy and
// visuals to the operator's selected platforms.
//
// Runs in plain Node, never in the Astro/workerd runtime. Nothing here (or anywhere under
// src/worker/ and src/lib/publishing/) may import astro:env/server or src/lib/supabase-admin;
// eslint.config.js enforces both directions of that boundary.
//
// Unlike visuals.ts/generate.ts, the actual status validation lives in runPublish() itself
// (Phase 3's own contract), not here — this entrypoint only resolves WHICH digest to target and
// reports the per-platform outcomes runPublish already recorded.
import { pathToFileURL } from "node:url";

import { resumeDigest } from "@/lib/digest/run-state";
import { createFacebookPublisher } from "@/lib/publishing/facebook";
import { createInstagramPublisher } from "@/lib/publishing/instagram";
import { createLinkedinPublisher } from "@/lib/publishing/linkedin";
import { runPublish } from "@/lib/publishing/run";
import type { Publisher } from "@/lib/publishing/types";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { loadWorkerEnv, type WorkerEnv } from "@/worker/env";
import type { DigestRun, DigestStatus, PublishSummary, RunStateResult, SelectionPlatform } from "@/types";

/** `--digest=<uuid>` names a specific digest to publish, bypassing the newest-eligible default. */
const DIGEST_FLAG = /^--digest=(.+)$/;

export function parseDigestFlag(argv: string[]): string | null {
  for (const arg of argv) {
    const match = DIGEST_FLAG.exec(arg);
    if (match) return match[1];
  }
  return null;
}

/** Thrown for an operator-facing refusal — printed without a stack trace, exit 2. */
export class PublishRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRefused";
  }
}

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.data;
}

/** A digest an explicit --digest may legally target: runPublish's own contract, mirrored here for an early, friendlier refusal. */
const PUBLISHABLE_STATUSES: DigestStatus[] = ["approved", "skipped", "published"];

async function candidatesInApprovedOrSkipped(client: ServiceClient): Promise<DigestRun[]> {
  const { data, error } = await client
    .from("digest")
    .select("*")
    .in("status", ["approved", "skipped"])
    .order("window_start", { ascending: false });
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data;
}

/** Whether any platform the operator selected for this digest has not yet recorded a success. */
async function hasPendingPlatform(client: ServiceClient, digestId: string): Promise<boolean> {
  const { data: selection, error: selectionError } = await client
    .from("selection")
    .select("platforms")
    .eq("digest_id", digestId)
    .maybeSingle();
  if (selectionError) throw new Error(`${selectionError.code}: ${selectionError.message}`);
  if (!selection || selection.platforms.length === 0) return false;

  const { data: existing, error: existingError } = await client
    .from("publication")
    .select("platform, status")
    .eq("digest_id", digestId);
  if (existingError) throw new Error(`${existingError.code}: ${existingError.message}`);

  const succeeded = new Set(existing.filter((row) => row.status === "success").map((row) => row.platform));
  return selection.platforms.some((platform) => !succeeded.has(platform));
}

async function newestWithPendingPlatform(client: ServiceClient): Promise<DigestRun | null> {
  for (const candidate of await candidatesInApprovedOrSkipped(client)) {
    if (await hasPendingPlatform(client, candidate.id)) return candidate;
  }
  return null;
}

/**
 * Resolve which digest this run targets.
 *
 * An explicit `--digest` wins and may name a digest already `published` -- a later platform
 * catching up after an earlier partial failure, exactly the retry `record_publication` itself
 * allows. Absent a flag, the default is the newest `approved`/`skipped` digest that still has a
 * platform pending; a `published` digest is never picked up implicitly, only by an explicit flag,
 * mirroring visuals.ts's "explicit retry only" precedent for a digest past its normal stage.
 */
export async function resolveTargetDigest(client: ServiceClient, digestId: string | null): Promise<DigestRun> {
  if (digestId) {
    const digest = unwrap(await resumeDigest(client, digestId));
    if (!PUBLISHABLE_STATUSES.includes(digest.status)) {
      throw new PublishRefused(
        `digest ${digestId} is in "${digest.status}", not approved, skipped, or published. ` +
          "Publishing only runs on a digest that has cleared the approval gate.",
      );
    }
    return digest;
  }

  const digest = await newestWithPendingPlatform(client);
  if (!digest) {
    throw new PublishRefused('no digest in "approved" or "skipped" has a platform still pending publication');
  }
  return digest;
}

/**
 * Which platform clients are usable, built from the worker's own environment. Split out from
 * main() so it stays testable with fake env values, mirroring visuals.ts's decksFrom().
 */
export function buildPublishers(env: WorkerEnv): Partial<Record<SelectionPlatform, Publisher>> {
  const publishers: Partial<Record<SelectionPlatform, Publisher>> = {};

  const instagram = createInstagramPublisher(
    env.META_ACCESS_TOKEN && env.META_IG_USER_ID
      ? { accessToken: env.META_ACCESS_TOKEN, igUserId: env.META_IG_USER_ID }
      : null,
  );
  if (instagram) publishers.instagram = instagram;

  const facebook = createFacebookPublisher(
    env.META_ACCESS_TOKEN && env.META_PAGE_ID ? { accessToken: env.META_ACCESS_TOKEN, pageId: env.META_PAGE_ID } : null,
  );
  if (facebook) publishers.facebook = facebook;

  const linkedin = createLinkedinPublisher(
    env.LINKEDIN_ACCESS_TOKEN && env.LINKEDIN_ORGANIZATION_URN
      ? { accessToken: env.LINKEDIN_ACCESS_TOKEN, organizationUrn: env.LINKEDIN_ORGANIZATION_URN }
      : null,
  );
  if (linkedin) publishers.linkedin = linkedin;

  return publishers;
}

/** One line per attempted platform, in the order they were attempted -- mirrors visuals.ts's summarize(). */
export function summarize(summary: PublishSummary): string {
  return summary
    .map((outcome) =>
      outcome.ok
        ? `  [${outcome.platform}] succeeded -- postId ${outcome.postId}`
        : `  [${outcome.platform}] failed: ${outcome.error}`,
    )
    .join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const env = loadWorkerEnv();
  const client = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const digest = await resolveTargetDigest(client, parseDigestFlag(argv));

  // Printed before any work starts, mirroring collect.ts, rank.ts, generate.ts and visuals.ts: the
  // operator must see the run targeted the digest they meant before anything is posted.
  console.log(`publishing digest ${digest.id}, week ${digest.window_start} -> ${digest.window_end}`);

  const publishers = buildPublishers(env);
  const outcome = await runPublish(client, digest.id, publishers);

  if (!outcome.ok) {
    console.error(`publishing did not complete: ${outcome.reason}: ${outcome.message}`);
    return 1;
  }

  if (outcome.data.length === 0) {
    console.log("nothing to publish -- every selected platform has already succeeded for this digest");
    return 0;
  }

  console.log(`${String(outcome.data.length)} platform(s) attempted:`);
  console.log(summarize(outcome.data));

  return outcome.data.some((result) => !result.ok) ? 1 : 0;
}

// Only run when executed directly, so the tests (and scheduled-run.ts) can import the helpers above.
// pathToFileURL rather than string concatenation: Windows paths (X:\...) do not form a
// valid file:// URL by prefixing, and this project is developed on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof PublishRefused) {
        console.error(error.message);
        process.exit(2);
      }
      console.error(error);
      process.exit(1);
    });
}
