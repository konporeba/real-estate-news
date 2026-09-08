// WORKER-SIDE ENTRYPOINT. `npm run generate` — the manual trigger for the generation stage
// (S-05), the process that consumes a digest the S-04 selection gate left in `generating`.
//
// Runs in plain Node, never in the Astro/workerd runtime. Nothing here (or anywhere under
// src/worker/ and src/lib/generation/) may import astro:env/server or src/lib/supabase-admin;
// eslint.config.js enforces both directions of that boundary.
//
// Unlike collect and rank, this stage is NOT part of the scheduled chain: it sits behind a human
// gate (the operator's picks), so nothing can predict when it becomes runnable. Manual only, the
// way S-01 and S-02 shipped before F-05 automated them.
import { pathToFileURL } from "node:url";

import { resumeDigest } from "@/lib/digest/run-state";
import { generateDigest } from "@/lib/generation/generate";
import { createLlmClient } from "@/lib/llm/client";
import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";
import { loadWorkerEnv } from "@/worker/env";
import type { DigestRun, KeyStatistic, RunStateResult, SourceTextOrigin } from "@/types";

/** `--digest=<uuid>` names a specific digest to generate, bypassing the newest-in-`generating` default. */
const DIGEST_FLAG = /^--digest=(.+)$/;

export function parseDigestFlag(argv: string[]): string | null {
  for (const arg of argv) {
    const match = DIGEST_FLAG.exec(arg);
    if (match) return match[1];
  }
  return null;
}

/** Thrown for an operator-facing refusal — printed without a stack trace. */
export class GenerateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateRefused";
  }
}

function unwrap<T>(result: RunStateResult<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.data;
}

async function newestInGenerating(client: ServiceClient): Promise<DigestRun | null> {
  const { data, error } = await client
    .from("digest")
    .select("*")
    .eq("status", "generating")
    .order("window_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data;
}

/**
 * Resolve which digest this run works on.
 *
 * An explicit `--digest` wins, and must already be in `generating` — naming one still collecting,
 * or one already awaiting approval, is a caller mistake rather than something to silently fix.
 * Absent a flag, the default is the newest digest in `generating`, the state `confirm_selection`
 * leaves a digest in the moment the operator passes the S-04 gate.
 */
export async function resolveTargetDigest(client: ServiceClient, digestId: string | null): Promise<DigestRun> {
  if (digestId) {
    const digest = unwrap(await resumeDigest(client, digestId));
    if (digest.status !== "generating") {
      throw new GenerateRefused(
        `digest ${digestId} is in "${digest.status}", not "generating". Generation only runs on a digest in "generating".`,
      );
    }
    return digest;
  }

  const digest = await newestInGenerating(client);
  if (!digest) {
    throw new GenerateRefused(
      'no digest is in "generating" — confirm a story selection on the dashboard first (S-04 gate)',
    );
  }
  return digest;
}

export interface GeneratedRow {
  polish_title: string;
  /** Narrowed from the column's `text`: the migration's check constraint is what guarantees it. */
  source_text_origin: SourceTextOrigin;
  source_char_count: number | null;
  key_statistics: KeyStatistic[];
}

async function fetchGeneratedCopy(client: ServiceClient, digestId: string): Promise<GeneratedRow[]> {
  const { data, error } = await client
    .from("generated_copy")
    .select("polish_title, source_text_origin, source_char_count, key_statistics")
    .eq("digest_id", digestId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return data as unknown as GeneratedRow[];
}

/**
 * One line per story. `source_text_origin` is on the operator-facing summary deliberately: a
 * `lede` row is the visible symptom of a source that has started refusing us, and the reason a
 * post reads shorter than the others.
 */
export function summarize(rows: GeneratedRow[]): string {
  return rows
    .map((row) => {
      const chars = row.source_char_count === null ? "?" : String(row.source_char_count);
      return `  [${row.source_text_origin.padEnd(7)} ${chars.padStart(6)} chars, ${String(row.key_statistics.length)} stats]  ${row.polish_title}`;
    })
    .join("\n");
}

// Generation leaves thinking ON (src/lib/generation/generate-copy.ts) and sends a whole article
// body as input, so a call deliberates for far longer than translation's mechanical pass. The
// SDK's 60s default is too tight for that; as src/lib/llm/client.ts argues, the fix for a slow
// call is a longer timeout rather than more retries. Shorter than rank's 5 minutes because this
// is one story at a time, not a whole-pool partition.
const LLM_TIMEOUT_MS = 3 * 60_000;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const env = loadWorkerEnv();
  const client = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const llm = createLlmClient(env.ANTHROPIC_API_KEY, { timeoutMs: LLM_TIMEOUT_MS });

  const digest = await resolveTargetDigest(client, parseDigestFlag(argv));

  // Printed before any work starts, mirroring collect.ts and rank.ts: the operator must see the
  // run targeted the digest they meant before any spend happens.
  console.log(`generating copy for digest ${digest.id}, week ${digest.window_start} -> ${digest.window_end}`);

  const outcome = await generateDigest(llm, client, digest, { ceilingUsd: env.LLM_COST_CEILING_USD });

  if (!outcome.ok) {
    console.error(`generation did not complete: ${outcome.reason}: ${outcome.message}`);
    return 1;
  }

  console.log(`digest is now "${outcome.data.digest.status}" (cost $${String(outcome.data.digest.cost_usd)})`);

  if (outcome.data.digest.status === "failed") {
    console.error(outcome.data.digest.last_error ?? "generation failed with no recorded reason");
    return 1;
  }

  const rows = await fetchGeneratedCopy(client, digest.id);
  console.log(`generated ${String(rows.length)} ${rows.length === 1 ? "story" : "stories"}:`);
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
      if (error instanceof GenerateRefused) {
        console.error(error.message);
        process.exit(2);
      }
      console.error(error);
      process.exit(1);
    });
}
