// WORKER-SIDE ENTRYPOINT. `npm run visuals` — the manual trigger for the rendering stage (S-06),
// the process that consumes a digest the generation stage left in `rendering`.
//
// Runs in plain Node, never in the Astro/workerd runtime. Nothing here (or anywhere under
// src/worker/ and src/lib/visuals/) may import astro:env/server or src/lib/supabase-admin;
// eslint.config.js enforces both directions of that boundary.
//
// Like generate, and unlike collect and rank, this stage is NOT part of the scheduled chain: it
// runs on the output of a human gate, so nothing can predict when it becomes runnable. Manual
// only. Re-running re-renders from scratch rather than resuming — the images cost nothing to
// redo, and a half-old, half-new set of cards is worse than a slower run.
import { pathToFileURL } from "node:url";

import { resumeDigest, transitionDigest } from "@/lib/digest/run-state";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { renderDigest, type RenderOptions } from "@/lib/visuals/render";
import { createSlidesClient } from "@/lib/visuals/slides-client";
import { createAssetStore } from "@/lib/visuals/store";
import { loadWorkerEnv, type WorkerEnv } from "@/worker/env";
import type { DigestRun, GeneratedAssetRow, RunStateResult } from "@/types";

/** `--digest=<uuid>` names a specific digest to render, bypassing the newest-in-`rendering` default. */
const DIGEST_FLAG = /^--digest=(.+)$/;

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.data;
}

export function parseDigestFlag(argv: string[]): string | null {
  for (const arg of argv) {
    const match = DIGEST_FLAG.exec(arg);
    if (match) return match[1];
  }
  return null;
}

/** Thrown for an operator-facing refusal — printed without a stack trace, exit 2. */
export class VisualsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualsRefused";
  }
}

async function newestInRendering(client: ServiceClient): Promise<DigestRun | null> {
  const { data, error } = await client
    .from("digest")
    .select("*")
    .eq("status", "rendering")
    .order("window_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data;
}

/**
 * Resolve which digest this run works on.
 *
 * An explicit `--digest` wins, and must already be in `rendering`. Absent a flag, the default is
 * the newest digest in `rendering`, the state `generateDigest()` leaves a digest in.
 *
 * ONE EXCEPTION, and only for an explicit `--digest`, mirroring generate.ts: a digest that FAILED
 * after generation completed is put back into `rendering` and retried. `generation_completed_at`
 * is what distinguishes a render failure from an earlier one — it is stamped only when generation
 * has fully succeeded, so a digest carrying it has copy to render and nothing to re-pay for. A
 * digest that failed before then is refused, because rendering has nothing to work from. The
 * retry is never implicit: the no-flag default still only picks up digests already in `rendering`.
 */
export async function resolveTargetDigest(client: ServiceClient, digestId: string | null): Promise<DigestRun> {
  if (digestId) {
    const digest = unwrap(await resumeDigest(client, digestId));

    if (digest.status === "failed") {
      if (digest.generation_completed_at === null) {
        throw new VisualsRefused(
          `digest ${digestId} is "failed" and never completed generation — there is no copy to render. ` +
            "Re-run generation instead (npm run generate --digest=" +
            digestId +
            ").",
        );
      }
      console.log(
        `digest ${digestId} failed after generation (${digest.last_error ?? "no recorded reason"}); re-rendering`,
      );
      return unwrap(await transitionDigest(client, digest.id, "rendering"));
    }

    if (digest.status !== "rendering") {
      throw new VisualsRefused(
        `digest ${digestId} is in "${digest.status}", not "rendering". Rendering only runs on a digest in "rendering".`,
      );
    }
    return digest;
  }

  const digest = await newestInRendering(client);
  if (!digest) {
    throw new VisualsRefused('no digest is in "rendering" — run `npm run generate` first (S-05)');
  }
  return digest;
}

/** The columns the operator-facing summary prints. */
export type AssetSummaryRow = Pick<GeneratedAssetRow, "slide_index" | "width" | "height" | "storage_path">;

/** One line per rendered slide, in the order they will be published. */
export function summarize(rows: AssetSummaryRow[]): string {
  return rows
    .map((row) => {
      const size = row.width && row.height ? `${String(row.width)}x${String(row.height)}` : "?";
      return `  [slide ${String(row.slide_index)}  ${size.padStart(9)}]  ${row.storage_path}`;
    })
    .join("\n");
}

async function fetchAssets(client: ServiceClient, digestId: string) {
  const { data, error } = await client
    .from("generated_asset")
    .select("slide_index, width, height, storage_path")
    .eq("digest_id", digestId)
    .order("slide_index", { ascending: true });
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data;
}

/**
 * Which decks are available, by format. Built here rather than in the orchestrator so the stage
 * itself stays free of environment access and remains testable with fake ids.
 */
export function decksFrom(env: WorkerEnv): RenderOptions["decks"] {
  const decks: RenderOptions["decks"] = {};
  if (env.SLIDES_DECK_SINGLE_POST) decks.single_post = env.SLIDES_DECK_SINGLE_POST;
  if (env.SLIDES_DECK_CAROUSEL) decks.carousel = env.SLIDES_DECK_CAROUSEL;
  return decks;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const env = loadWorkerEnv();
  const client = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  // Refused BEFORE a digest is touched, unlike the orchestrator's own not-configured branch: a
  // missing credential is the operator's setup, not a verdict on the week, and marking the digest
  // `failed` for it would demand a state hop before they could retry. renderDigest keeps its own
  // guard for any other caller.
  const slidesConfig =
    env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY_B64
      ? { serviceAccountEmail: env.GOOGLE_SA_EMAIL, privateKeyBase64: env.GOOGLE_SA_PRIVATE_KEY_B64 }
      : null;
  if (!slidesConfig) {
    throw new VisualsRefused(
      "GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY_B64 must be set to render visuals. See .env.example, " +
        "and `npm run visuals:validate` to check the decks once they are.",
    );
  }

  const slides = createSlidesClient(slidesConfig);
  if (!slides) {
    throw new VisualsRefused(
      "GOOGLE_SA_PRIVATE_KEY_B64 could not be decoded into a private key. It should be the base64 of either " +
        "the PEM key or the whole service-account JSON file.",
    );
  }

  const decks = decksFrom(env);
  if (Object.keys(decks).length === 0) {
    throw new VisualsRefused(
      "No template decks are configured. Set SLIDES_DECK_SINGLE_POST and SLIDES_DECK_CAROUSEL in .env — " +
        "the presentation id is the part of the Slides URL between /d/ and /edit.",
    );
  }

  const digest = await resolveTargetDigest(client, parseDigestFlag(argv));

  // Printed before any work starts, mirroring collect.ts, rank.ts and generate.ts: the operator
  // must see the run targeted the digest they meant before the deck is touched.
  console.log(`rendering visuals for digest ${digest.id}, week ${digest.window_start} -> ${digest.window_end}`);

  const storage = createAssetStore(client, env.SUPABASE_ASSET_BUCKET);
  const outcome = await renderDigest(slides, storage, client, digest, { decks });

  if (!outcome.ok) {
    console.error(`rendering did not complete: ${outcome.reason}: ${outcome.message}`);
    return 1;
  }

  console.log(`digest is now "${outcome.data.digest.status}"`);

  if (outcome.data.digest.status === "failed") {
    console.error(outcome.data.digest.last_error ?? "rendering failed with no recorded reason");
    return 1;
  }

  const rows = await fetchAssets(client, digest.id);
  console.log(`rendered ${String(rows.length)} ${rows.length === 1 ? "image" : "images"} into ${storage.bucket}:`);
  console.log(summarize(rows));
  return 0;
}

// Only run when executed directly, so the tests can import the helpers above.
// pathToFileURL rather than string concatenation: Windows paths (X:\...) do not form a
// valid file:// URL by prefixing, and this project is developed on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof VisualsRefused) {
        console.error(error.message);
        process.exit(2);
      }
      console.error(error);
      process.exit(1);
    });
}
