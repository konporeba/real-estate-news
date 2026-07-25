// WORKER-SIDE. Converts a zod schema into the Anthropic structured-output format, and rejects
// schema shapes the API does not support BEFORE a call is made — so a bad schema fails in the
// caller's tests, not with a 400 mid-run on an unattended Sunday.
//
// Structured outputs constrain the response to valid JSON matching the schema, which is what makes
// FR-017's "malformed output" rare. The limits below are the API's documented ones: no numeric or
// string-length constraints, no recursion, `additionalProperties: false` on every object. zod v4's
// toJSONSchema already emits `additionalProperties: false` and inlines nested objects (so a `$ref`
// only appears for genuine recursion), which is why the walker can be this simple.
import { z } from "zod";

import type { JSONOutputFormat } from "@anthropic-ai/sdk/resources/messages";

/** JSON Schema keywords structured outputs reject. Finding one means the schema can't be used. */
const UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "patternProperties",
  "$ref", // zod inlines reuse, so a $ref here is a recursive schema
  "$defs",
] as const;

type JsonSchemaNode = Record<string, unknown>;

/** First unsupported keyword found anywhere in the schema, with a dotted path, or null. */
function findUnsupported(node: unknown, path: string): { keyword: string; path: string } | null {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) {
      const hit = findUnsupported(child, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (node === null || typeof node !== "object") return null;

  const obj = node as JsonSchemaNode;
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in obj) return { keyword, path: path || "(root)" };
  }
  for (const [key, child] of Object.entries(obj)) {
    const hit = findUnsupported(child, path ? `${path}.${key}` : key);
    if (hit) return hit;
  }
  return null;
}

export type StructuredFormatResult = { ok: true; format: JSONOutputFormat } | { ok: false; message: string };

/**
 * Convert a zod schema to the Anthropic `output_config.format`. Returns a failure (not a throw)
 * when the schema uses an unsupported constraint, naming the keyword and path so the fix is
 * obvious. `$schema` is stripped — it is metadata the API does not need.
 */
export function toStructuredFormat(schema: z.ZodType): StructuredFormatResult {
  const json = z.toJSONSchema(schema) as JsonSchemaNode;
  delete json.$schema;

  const unsupported = findUnsupported(json, "");
  if (unsupported) {
    return {
      ok: false,
      message: `unsupported output schema: "${unsupported.keyword}" at ${unsupported.path} is not supported by structured outputs`,
    };
  }

  return { ok: true, format: { type: "json_schema", schema: json } };
}
