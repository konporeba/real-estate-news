// Integration tests for the atomic lockout primitive (F-02 Phase 1). They exercise the real
// `record_pin_attempt` function against `pin_lockout_state`, because its guarantees --
// check-and-record as one round trip, no extension of an active lockout by continued probing --
// live in Postgres, not in TypeScript. Same opt-in as every other integration suite:
// SUPABASE_TEST_PROJECT=1 on top of the service key.
//
// pin_lockout_state is a singleton (one row, always) rather than per-run like `digest`, so there
// is no "fresh row per test" isolation trick -- every test resets the single row first instead.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createServiceClient, type ServiceClient } from "@/lib/supabase-service";

const configured = Boolean(
  process.env.SUPABASE_TEST_PROJECT === "1" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 900;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the integration suite`);
  return value;
}

function serviceClient(): ServiceClient {
  return createServiceClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

async function resetLockoutState(db: ServiceClient): Promise<void> {
  const { error } = await db
    .from("pin_lockout_state")
    .update({ failed_attempts: 0, locked_until: null })
    .eq("id", true);
  if (error) throw new Error(`failed to reset pin_lockout_state: ${error.message}`);
}

async function attempt(db: ServiceClient, matched: boolean) {
  const { data, error } = await db.rpc("record_pin_attempt", {
    p_matched: matched,
    p_max_attempts: MAX_ATTEMPTS,
    p_lockout_seconds: LOCKOUT_SECONDS,
  });
  if (error) throw new Error(error.message);
  return data[0];
}

async function currentRow(db: ServiceClient) {
  const { data, error } = await db
    .from("pin_lockout_state")
    .select("failed_attempts, locked_until")
    .eq("id", true)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

let db: ServiceClient;

describe.skipIf(!configured)("record_pin_attempt (integration)", () => {
  beforeEach(async () => {
    db = serviceClient();
    await resetLockoutState(db);
  });
  afterAll(async () => resetLockoutState(db));

  it("does not lock out before the 5th consecutive failed attempt", async () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      const result = await attempt(db, false);
      expect(result.authenticated).toBe(false);
      expect(result.locked_until).toBeNull();
    }
  });

  it("locks out exactly on the 5th consecutive failed attempt", async () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      await attempt(db, false);
    }
    const result = await attempt(db, false);
    expect(result.authenticated).toBe(false);
    expect(result.locked_until).not.toBeNull();
  });

  it("a correct PIN clears an active lockout and authenticates immediately", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await attempt(db, false);
    }
    expect((await currentRow(db)).locked_until).not.toBeNull();

    const result = await attempt(db, true);
    expect(result.authenticated).toBe(true);
    expect(result.locked_until).toBeNull();

    const row = await currentRow(db);
    expect(row.failed_attempts).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it("a wrong guess during an active lockout does not extend it", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await attempt(db, false);
    }
    const lockedAt = (await currentRow(db)).locked_until;
    expect(lockedAt).not.toBeNull();

    const result = await attempt(db, false);
    expect(result.authenticated).toBe(false);
    expect(result.locked_until).toBe(lockedAt);

    const row = await currentRow(db);
    expect(row.failed_attempts).toBe(MAX_ATTEMPTS);
    expect(row.locked_until).toBe(lockedAt);
  });
});
