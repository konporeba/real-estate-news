// Unit tests for the selection rules, plus a drift guard against the SQL that re-enforces them.
//
// The rules exist in two places by design: `confirm_selection` is authoritative, and this module
// mirrors it so the island can show a live 2-4 counter without a round trip. That duplication is
// the accepted tradeoff recorded in the plan — the drift guard at the bottom is what makes it
// safe, in the same way src/lib/digest/state-machine.test.ts parses the transition trigger.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Constants } from "@/db/database.types";
import {
  isPickCountValid,
  isSubmittable,
  MAX_PICKS,
  MIN_PICKS,
  SELECTION_FORMATS,
  SELECTION_PLATFORMS,
  selectionRequestSchema,
} from "@/lib/selection/rules";

const CLUSTER_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
];
const DIGEST_ID = "99999999-9999-4999-8999-999999999999";

function request(overrides: Record<string, unknown> = {}) {
  return {
    digestId: DIGEST_ID,
    shortlistClusterIds: CLUSTER_IDS,
    pickedClusterIds: CLUSTER_IDS.slice(0, 3),
    format: "carousel",
    platforms: ["instagram"],
    ...overrides,
  };
}

/** The first issue's message — what the endpoint returns and the island renders. */
function reject(input: Record<string, unknown>): string {
  const result = selectionRequestSchema.safeParse(input);
  if (result.success) throw new Error("expected the schema to reject this input");
  return result.error.issues[0].message;
}

describe("pick-count helpers", () => {
  it("accepts every count in the inclusive 2-4 range", () => {
    expect(isPickCountValid(2)).toBe(true);
    expect(isPickCountValid(3)).toBe(true);
    expect(isPickCountValid(4)).toBe(true);
  });

  it("rejects counts on either side of the range", () => {
    expect(isPickCountValid(0)).toBe(false);
    expect(isPickCountValid(1)).toBe(false);
    expect(isPickCountValid(5)).toBe(false);
  });

  it("requires at least one platform on top of a valid pick count", () => {
    expect(isSubmittable(3, 1)).toBe(true);
    expect(isSubmittable(3, 0)).toBe(false);
    expect(isSubmittable(1, 2)).toBe(false);
  });
});

describe("selectionRequestSchema", () => {
  it("accepts the boundary pick counts and everything between", () => {
    for (const count of [2, 3, 4]) {
      const result = selectionRequestSchema.safeParse(request({ pickedClusterIds: CLUSTER_IDS.slice(0, count) }));
      expect(result.success).toBe(true);
    }
  });

  it("accepts every format and every platform combination", () => {
    for (const format of SELECTION_FORMATS) {
      expect(selectionRequestSchema.safeParse(request({ format })).success).toBe(true);
    }
    expect(selectionRequestSchema.safeParse(request({ platforms: [...SELECTION_PLATFORMS] })).success).toBe(true);
  });

  it("rejects too few picks", () => {
    expect(reject(request({ pickedClusterIds: [] }))).toContain("between 2 and 4");
    expect(reject(request({ pickedClusterIds: CLUSTER_IDS.slice(0, 1) }))).toContain("between 2 and 4");
  });

  it("rejects too many picks", () => {
    expect(reject(request({ pickedClusterIds: CLUSTER_IDS.slice(0, 5) }))).toContain("between 2 and 4");
  });

  it("rejects the same story selected twice rather than counting it once", () => {
    const duplicated = [CLUSTER_IDS[0], CLUSTER_IDS[0], CLUSTER_IDS[1]];
    expect(reject(request({ pickedClusterIds: duplicated }))).toContain("selected twice");
  });

  it("rejects a pick that is not on the shortlist", () => {
    const offList = [CLUSTER_IDS[0], "abcdef00-0000-4000-8000-000000000000"];
    expect(reject(request({ pickedClusterIds: offList }))).toContain("must be on the shortlist");
  });

  it("rejects a shortlist containing duplicates", () => {
    expect(reject(request({ shortlistClusterIds: [...CLUSTER_IDS, CLUSTER_IDS[0]] }))).toContain("duplicate");
  });

  it("rejects an empty shortlist", () => {
    expect(reject(request({ shortlistClusterIds: [] }))).toContain("must not be empty");
  });

  it("rejects an empty platform list", () => {
    expect(reject(request({ platforms: [] }))).toContain("at least one platform");
  });

  it("rejects an unknown format or platform", () => {
    expect(selectionRequestSchema.safeParse(request({ format: "infographic" })).success).toBe(false);
    expect(selectionRequestSchema.safeParse(request({ platforms: ["tiktok"] })).success).toBe(false);
  });

  it("rejects ids that are not uuids", () => {
    expect(selectionRequestSchema.safeParse(request({ digestId: "not-a-uuid" })).success).toBe(false);
    expect(selectionRequestSchema.safeParse(request({ pickedClusterIds: ["a", "b"] })).success).toBe(false);
  });

  it("rejects a body that is not an object at all", () => {
    expect(selectionRequestSchema.safeParse(null).success).toBe(false);
    expect(selectionRequestSchema.safeParse("carousel").success).toBe(false);
  });
});

describe("vocabulary", () => {
  it("covers every value of the Postgres enums", () => {
    // Constants only carries digest_status (the sole enum with a consumer), so the enum members
    // are asserted against the generated union instead, via exhaustive const arrays.
    expect(Constants.public.Enums.digest_status).toContain("ready_for_selection");
    expect([...SELECTION_FORMATS].sort()).toEqual(["carousel", "single_post"]);
    expect([...SELECTION_PLATFORMS].sort()).toEqual(["facebook", "instagram", "linkedin"]);
  });
});

// --- migration parsing (drift guard) ----------------------------------------------
// confirm_selection() is authoritative for the pick bounds and the platform minimum. These
// helpers read them straight out of the SQL so changing one side without the other fails here
// rather than in production, where the island would enable a submit the database then rejects.

function readMigrations(marker: string, pick: "first" | "latest"): string {
  const dir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(dir + file, "utf8"))
    .filter((sql) => sql.includes(marker));

  const chosen = pick === "latest" ? migrations.at(-1) : migrations.at(0);
  if (!chosen) throw new Error(`no migration containing "${marker}" was found`);
  return chosen;
}

// The function body is read from the LATEST migration that defines it: `create or replace
// function` means a later migration supersedes the original, and the bounds this guard checks
// must come from whichever definition the database actually holds.
const migrationSql = readMigrations("function public.confirm_selection", "latest");

// The enums are declared exactly once and never replaced, so they are read from the FIRST
// migration that creates them rather than from whatever file last touched the function.
const enumSql = readMigrations("create type selection_format", "first");

describe("drift guard: the SQL and this module must agree", () => {
  it("uses the same pick bounds as confirm_selection()", () => {
    const match = /v_picked_count < (\d+) or v_picked_count > (\d+)/.exec(migrationSql);
    if (!match) throw new Error("could not parse the pick-count bounds from confirm_selection()");

    expect(Number(match[1])).toBe(MIN_PICKS);
    expect(Number(match[2])).toBe(MAX_PICKS);
  });

  it("uses the same platform minimum as confirm_selection()", () => {
    const match = /cardinality\(p_platforms\) < (\d+)/.exec(migrationSql);
    if (!match) throw new Error("could not parse the platform minimum from confirm_selection()");

    expect(Number(match[1])).toBe(1);
  });

  it("declares the same format and platform values as the enums in the migration", () => {
    const formats = /create type selection_format as enum \(([^)]+)\)/.exec(enumSql);
    const platforms = /create type selection_platform as enum \(([^)]+)\)/.exec(enumSql);
    if (!formats?.[1] || !platforms?.[1]) throw new Error("could not parse the selection enums");

    const values = (list: string) =>
      list
        .split(",")
        .map((v) => v.trim().replace(/'/g, ""))
        .sort();

    expect(values(formats[1])).toEqual([...SELECTION_FORMATS].sort());
    expect(values(platforms[1])).toEqual([...SELECTION_PLATFORMS].sort());
  });
});
