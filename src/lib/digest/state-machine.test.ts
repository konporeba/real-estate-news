import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Constants } from "@/db/database.types";
import { canTransition, isTerminal, TERMINAL_STATES, TRANSITIONS } from "@/lib/digest/state-machine";
import type { DigestStatus } from "@/types";

const ALL_STATUSES = Constants.public.Enums.digest_status;

// --- migration parsing (drift guard) ----------------------------------------------
// The database trigger is authoritative. These helpers read the allowed map straight out
// of the SQL so a change to one side without the other fails the suite.

function readTriggerMigration(): string {
  const dir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(dir + file, "utf8"))
    .filter((sql) => sql.includes("enforce_digest_transition"));

  const latest = migrations.at(-1);
  if (!latest) throw new Error("no migration defining enforce_digest_transition() was found");
  return latest;
}

/** Extracts `old.status = 'x' and new.status in ('y', 'z')` clauses from the trigger. */
function parseAllowedTransitions(sql: string): Record<string, string[]> {
  const clause = /\(old\.status = '(\w+)'\s+and new\.status (?:in \(([^)]+)\)|= '(\w+)')\)/g;
  const parsed: Record<string, string[]> = {};

  for (const [, from, list, single] of sql.matchAll(clause)) {
    const targets = single ? [single] : list.split(",").map((value) => value.trim().replace(/'/g, ""));
    parsed[from] = [...(parsed[from] ?? []), ...targets];
  }
  return parsed;
}

/** Extracts the states excluded from the `one_active_digest_per_week` partial index. */
function parseIndexTerminalStates(sql: string): string[] {
  const match = /where status not in \(([^)]+)\)/.exec(sql);
  if (!match?.[1]) throw new Error("could not parse the partial unique index predicate");
  return match[1].split(",").map((value) => value.trim().replace(/'/g, ""));
}

const migrationSql = readTriggerMigration();
const migrationTransitions = parseAllowedTransitions(migrationSql);

describe("TRANSITIONS", () => {
  it("covers every digest_status value", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("only targets known statuses", () => {
    for (const targets of Object.values(TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });

  it("declares no self-transitions", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(targets).not.toContain(from);
    }
  });

  it("leaves published with no outgoing move", () => {
    expect(TRANSITIONS.published).toEqual([]);
  });
});

describe("canTransition", () => {
  it("accepts every legal pair", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS) as [DigestStatus, DigestStatus[]][]) {
      for (const to of targets) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it("rejects every pair not in the map", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (TRANSITIONS[from].includes(to)) continue;
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it.each([
    ["collecting", "published"],
    ["collecting", "approved"],
    ["ranking", "generating"],
    ["published", "collecting"],
    ["failed", "ranking"],
  ] as [DigestStatus, DigestStatus][])("rejects %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("treats a no-op as not a transition", () => {
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("allows the manual escape hatches (US-19 skipped -> published, FR-018 failed -> collecting)", () => {
    expect(canTransition("skipped", "published")).toBe(true);
    expect(canTransition("failed", "collecting")).toBe(true);
  });
});

describe("TERMINAL_STATES", () => {
  it("matches the states excluded from the partial unique index", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(parseIndexTerminalStates(migrationSql).sort());
  });

  it("classifies statuses correctly", () => {
    for (const status of ALL_STATUSES) {
      expect(isTerminal(status)).toBe((TERMINAL_STATES as readonly DigestStatus[]).includes(status));
    }
    expect(isTerminal("collecting")).toBe(false);
    expect(isTerminal("published")).toBe(true);
  });
});

describe("parity with the migration's trigger", () => {
  it("parses a non-empty map out of the SQL", () => {
    expect(Object.keys(migrationTransitions).length).toBeGreaterThan(0);
  });

  it("matches the TypeScript map exactly", () => {
    // `published` is terminal: absent from the SQL clauses, empty in TRANSITIONS.
    const fromSql = Object.fromEntries(
      ALL_STATUSES.map((status) => [status, [...(migrationTransitions[status] ?? [])].sort()]),
    );
    const fromTs = Object.fromEntries(ALL_STATUSES.map((status) => [status, [...TRANSITIONS[status]].sort()]));

    expect(fromTs).toEqual(fromSql);
  });
});
