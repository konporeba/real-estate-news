// Unit tests for the approval rules, plus a drift guard against the SQL that re-enforces them.
//
// The rules exist in two places by design: `record_approval` is authoritative, and this module
// mirrors it so the island can show a live character count without a round trip. That duplication
// is the accepted tradeoff recorded in the plan — the drift guard at the bottom is what makes it
// safe, in the same way src/lib/selection/rules.test.ts parses confirm_selection().
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Constants } from "@/db/database.types";
import { APPROVAL_DECISIONS, approvalRequestSchema, MAX_NOTE_LENGTH } from "@/lib/approval/rules";

const DIGEST_ID = "99999999-9999-4999-8999-999999999999";

function request(overrides: Record<string, unknown> = {}) {
  return {
    digestId: DIGEST_ID,
    decision: "approved",
    ...overrides,
  };
}

/** The first issue's message — what the endpoint returns and the island renders. */
function reject(input: Record<string, unknown>): string {
  const result = approvalRequestSchema.safeParse(input);
  if (result.success) throw new Error("expected the schema to reject this input");
  return result.error.issues[0].message;
}

describe("approvalRequestSchema", () => {
  it("accepts a decision with no note", () => {
    const result = approvalRequestSchema.safeParse(request());
    expect(result.success).toBe(true);
    expect(result.success && result.data.note).toBeUndefined();
  });

  it("accepts every decision", () => {
    for (const decision of APPROVAL_DECISIONS) {
      expect(approvalRequestSchema.safeParse(request({ decision })).success).toBe(true);
    }
  });

  it("accepts a decision with a note", () => {
    const result = approvalRequestSchema.safeParse(request({ note: "the title reads clumsily" }));
    expect(result.success).toBe(true);
    expect(result.success && result.data.note).toBe("the title reads clumsily");
  });

  it("trims a note before storing it", () => {
    const result = approvalRequestSchema.safeParse(request({ note: "  padded  " }));
    expect(result.success && result.data.note).toBe("padded");
  });

  it("treats a whitespace-only note as absent rather than an empty string", () => {
    const result = approvalRequestSchema.safeParse(request({ note: "   " }));
    expect(result.success).toBe(true);
    expect(result.success && result.data.note).toBeUndefined();
  });

  it("accepts a note at exactly the length limit", () => {
    const note = "x".repeat(MAX_NOTE_LENGTH);
    expect(approvalRequestSchema.safeParse(request({ note })).success).toBe(true);
  });

  it("rejects a note over the length limit", () => {
    const note = "x".repeat(MAX_NOTE_LENGTH + 1);
    expect(reject(request({ note }))).toContain(`${String(MAX_NOTE_LENGTH)} characters or fewer`);
  });

  it("rejects an unknown decision", () => {
    expect(approvalRequestSchema.safeParse(request({ decision: "maybe" })).success).toBe(false);
  });

  it("rejects a digestId that is not a uuid", () => {
    expect(approvalRequestSchema.safeParse(request({ digestId: "not-a-uuid" })).success).toBe(false);
  });

  it("rejects a body that is not an object at all", () => {
    expect(approvalRequestSchema.safeParse(null).success).toBe(false);
    expect(approvalRequestSchema.safeParse("approved").success).toBe(false);
  });
});

describe("vocabulary", () => {
  it("covers every value of the approval_decision enum", () => {
    expect([...APPROVAL_DECISIONS].sort()).toEqual(["approved", "rejected"]);
  });

  // record_approval() casts a decision straight into digest_status (the decision IS the status
  // it produces), so both members must also be legal digest_status values — the same relationship
  // src/lib/digest/state-machine.ts's TERMINAL_STATES has with the enum it draws from.
  it("every decision is also a digest_status value", () => {
    for (const decision of APPROVAL_DECISIONS) {
      expect(Constants.public.Enums.digest_status).toContain(decision);
    }
  });
});

// --- migration parsing (drift guard) ----------------------------------------------
// record_approval() is authoritative for the note-length limit. This helper reads it straight out
// of the SQL so changing one side without the other fails here rather than in production, where
// the island would enable a submit the database then rejects.

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
// function` means a later migration supersedes the original, and the limit this guard checks must
// come from whichever definition the database actually holds.
const migrationSql = readMigrations("function public.record_approval", "latest");

// The enum is declared exactly once and never replaced, so it is read from the FIRST migration
// that creates it rather than from whatever file last touched the function.
const enumSql = readMigrations("create type approval_decision", "first");

describe("drift guard: the SQL and this module must agree", () => {
  it("uses the same note-length limit as record_approval()", () => {
    const match = /char_length\(p_note\) > (\d+)/.exec(migrationSql);
    if (!match) throw new Error("could not parse the note-length limit from record_approval()");

    expect(Number(match[1])).toBe(MAX_NOTE_LENGTH);
  });

  it("declares the same decision values as the enum in the migration", () => {
    const match = /create type approval_decision as enum \(([^)]+)\)/.exec(enumSql);
    if (!match?.[1]) throw new Error("could not parse the approval_decision enum");

    const values = match[1]
      .split(",")
      .map((v) => v.trim().replace(/'/g, ""))
      .sort();

    expect(values).toEqual([...APPROVAL_DECISIONS].sort());
  });
});
