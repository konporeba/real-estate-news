// F-02: PIN-gate cutover. No DB read per request -- the session cookie is self-verifying.
import { defineMiddleware } from "astro:middleware";
import { SESSION_SECRET } from "astro:env/server";

import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

const PROTECTED_ROUTES = ["/dashboard"];

export const onRequest = defineMiddleware(async (context, next) => {
  const token = context.cookies.get(SESSION_COOKIE_NAME)?.value;
  const authenticated = token && SESSION_SECRET ? await verifySessionToken(token, SESSION_SECRET) : false;
  context.locals.operatorAuthenticated = authenticated;

  if (PROTECTED_ROUTES.some((route) => context.url.pathname.startsWith(route)) && !authenticated) {
    return context.redirect("/auth/pin");
  }

  return next();
});
