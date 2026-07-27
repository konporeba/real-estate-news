import { describe, expect, it } from "vitest";

import { pinInputSchema } from "@/lib/auth/pin-input";

describe("pinInputSchema", () => {
  it("accepts a 6-digit string", () => {
    expect(pinInputSchema.safeParse("123456").success).toBe(true);
  });

  it("rejects too few digits", () => {
    expect(pinInputSchema.safeParse("12345").success).toBe(false);
  });

  it("rejects too many digits", () => {
    expect(pinInputSchema.safeParse("1234567").success).toBe(false);
  });

  it("rejects non-digit characters", () => {
    expect(pinInputSchema.safeParse("12a456").success).toBe(false);
  });

  it("rejects non-string input, e.g. a File from a malformed submission", () => {
    expect(pinInputSchema.safeParse(new File([], "x")).success).toBe(false);
  });

  it("rejects null (a missing form field)", () => {
    expect(pinInputSchema.safeParse(null).success).toBe(false);
  });
});
