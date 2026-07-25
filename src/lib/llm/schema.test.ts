import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toStructuredFormat } from "@/lib/llm/schema";

describe("toStructuredFormat", () => {
  it("converts a clean object schema and strips $schema", () => {
    const result = toStructuredFormat(z.object({ id: z.string(), score: z.number(), tier: z.enum(["a", "b"]) }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format.type).toBe("json_schema");
    expect(result.format.schema.$schema).toBeUndefined();
    expect(result.format.schema.additionalProperties).toBe(false); // zod v4 emits this; the API requires it
  });

  it("inlines a reused nested object without a $ref (so it is not mistaken for recursion)", () => {
    const inner = z.object({ x: z.string() });
    const result = toStructuredFormat(z.object({ a: inner, b: inner }));

    expect(result.ok).toBe(true);
  });

  it("rejects a numeric constraint, naming the keyword", () => {
    const result = toStructuredFormat(z.object({ score: z.number().min(0).max(1) }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("minimum");
  });

  it("rejects a string-length constraint", () => {
    const result = toStructuredFormat(z.object({ title: z.string().min(3) }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("minLength");
  });

  it("rejects an array-length constraint", () => {
    const result = toStructuredFormat(z.object({ items: z.array(z.string()).min(1) }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("minItems");
  });

  it("names the path to the offending constraint", () => {
    const result = toStructuredFormat(z.object({ nested: z.object({ count: z.number().min(0) }) }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/nested/);
  });
});
