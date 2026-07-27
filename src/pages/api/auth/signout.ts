// F-02: no server-side session state to invalidate -- signing out is just clearing the cookie.
import type { APIRoute } from "astro";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

export const prerender = false;

export const POST: APIRoute = (context) => {
  context.cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
  return context.redirect("/auth/pin");
};
