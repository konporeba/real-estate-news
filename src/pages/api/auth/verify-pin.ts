// F-02: validates the submitted PIN, atomically checks-and-records the attempt against the
// Phase 1 lockout RPC, and on success sets the signed session cookie. Shape validation
// (pinInputSchema) runs before any crypto or DB work so a malformed submission never counts as
// a guess against the lockout counter.
import type { APIRoute } from "astro";
import { PIN_HASH, PIN_PEPPER, SESSION_SECRET } from "astro:env/server";

import { pinInputSchema } from "@/lib/auth/pin-input";
import { verifyPin } from "@/lib/auth/pin";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session";
import { createServiceClient } from "@/lib/supabase-admin";

export const prerender = false;

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 900;

export const POST: APIRoute = async (context) => {
  const form = await context.request.formData();
  const parsedPin = pinInputSchema.safeParse(form.get("pin"));
  if (!parsedPin.success) {
    return context.redirect("/auth/pin?error=invalid");
  }

  // Fails closed on missing config, same as an incorrect PIN: no distinct error message that
  // would tell a caller which secret to go looking for.
  if (!PIN_HASH || !PIN_PEPPER || !SESSION_SECRET) {
    return context.redirect("/auth/pin?error=invalid");
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return context.redirect("/auth/pin?error=invalid");
  }

  const matched = await verifyPin(parsedPin.data, PIN_PEPPER, PIN_HASH);

  const { data, error } = await supabase.rpc("record_pin_attempt", {
    p_matched: matched,
    p_max_attempts: MAX_ATTEMPTS,
    p_lockout_seconds: LOCKOUT_SECONDS,
  });
  const result = data?.[0];

  if (error || !result) {
    return context.redirect("/auth/pin?error=invalid");
  }

  if (!result.authenticated) {
    if (result.locked_until) {
      return context.redirect(`/auth/pin?error=locked&until=${encodeURIComponent(result.locked_until)}`);
    }
    return context.redirect("/auth/pin?error=invalid");
  }

  const token = await createSessionToken(SESSION_SECRET, SESSION_MAX_AGE_SECONDS);
  context.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return context.redirect("/dashboard");
};
