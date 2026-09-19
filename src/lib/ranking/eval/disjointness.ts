// Mechanically enforces the constraint rubric.ts documents: few-shot content must never overlap
// EVAL_EXAMPLES, or the eval would measure memorization instead of generalization.
import { EVAL_EXAMPLES } from "@/lib/ranking/eval/examples";
import type { FewShotExample } from "@/lib/ranking/few-shot";

function normalize(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Returns the normalized titles present in both `examples` and the held-out `EVAL_EXAMPLES` set.
 * Empty array means safe (disjoint). Title match is sufficient since EVAL_EXAMPLES titles are
 * themselves the unique identifying text.
 */
export function findEvalOverlap(examples: FewShotExample[]): string[] {
  const evalTitles = new Set(EVAL_EXAMPLES.map((e) => normalize(e.title)));
  const overlap = new Set<string>();
  for (const example of examples) {
    const normalized = normalize(example.title);
    if (evalTitles.has(normalized)) overlap.add(normalized);
  }
  return [...overlap];
}
