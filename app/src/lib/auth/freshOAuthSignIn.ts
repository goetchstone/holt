// /app/src/lib/auth/freshOAuthSignIn.ts
//
// An OAuth sign-in is always a fresh sign-in, as whoever the OAuth identity
// belongs to (2026-11-21).
//
// NextAuth (4.24, core/lib/callback-handler.js) reads the session cookie on an
// OAuth callback, and when the incoming Google/Okta/Azure account is linked to
// nobody it links it onto the user ALREADY signed in at that browser. The signIn
// callback in pages/api/auth/[...nextauth].ts sees only the incoming identity,
// so any active staff member at a browser where the Owner was signed in could
// finish consent with their own account and leave it joined to the Owner: every
// later sign-in with it was the Owner.
//
// So the [...nextauth] handler hides the session cookie from NextAuth on an
// OAuth sign-in's two requests (`signin/<provider>` and `callback/<provider>`),
// and NextAuth takes its not-signed-in branch. Hiding it, rather than refusing
// the request, keeps "someone else signs in at a shared register" working: the
// next person signs in with their own account and the register becomes theirs,
// with no sign-out first.
//
// On the callback the old cookie is also ended in the reply, before NextAuth
// writes the new one. NextAuth clears the old session's leftover pieces itself,
// but only the ones it can see, and it can no longer see them. The cost: a
// callback that ends in a refusal (or a cancelled consent) leaves the browser
// signed out rather than still signed in as the person before.
//
// The password sign-in (`credentials`) is left alone: its callback never reads
// the session (core/routes/callback.js), and a mistyped password at a register
// should not sign out whoever is there. Every other provider id, known or not,
// gets the fresh sign-in -- the safe side for a provider added later.

import type { NextApiRequest, NextApiResponse } from "next";

/** NextAuth's session cookie, either prefix, whole or as one of its numbered pieces. */
const SESSION_COOKIE = /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?$/;

export function isSessionCookie(name: string): boolean {
  return SESSION_COOKIE.test(name);
}

/** The NextAuth action this request is, when it starts or finishes a sign-in that may link. */
export function freshSignInAction(
  route: readonly string[],
  providerTypeOf: (id: string) => string | undefined,
): "signin" | "callback" | null {
  const [action, providerId] = route;
  if ((action !== "signin" && action !== "callback") || !providerId) return null;
  if (providerTypeOf(providerId) === "credentials") return null;
  return action;
}

/** A Set-Cookie value that ends `name` in the browser. */
export function expiredCookie(name: string): string {
  const secure = name.startsWith("__Secure-") ? "; Secure" : "";
  return `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * Make an OAuth sign-in request a fresh one, before NextAuth sees it: drop the
 * session cookie from what NextAuth reads, and on the callback end it in the
 * reply too. Leaves every other request, and every other cookie (state, PKCE,
 * CSRF, callback URL), as it was.
 */
export function startFreshOAuthSignIn(
  req: NextApiRequest,
  res: NextApiResponse,
  providerTypeOf: (id: string) => string | undefined,
): void {
  const route = Array.isArray(req.query.nextauth) ? req.query.nextauth : [];
  const action = freshSignInAction(route, providerTypeOf);
  if (!action) return;
  const cookies = req.cookies ?? {};
  const dropped = Object.keys(cookies).filter(isSessionCookie);
  if (dropped.length === 0) return;
  req.cookies = Object.fromEntries(
    Object.entries(cookies).filter(([name]) => !isSessionCookie(name)),
  );
  // NextAuth appends its own cookies after these (next-auth/next/utils.js
  // setCookie), and the browser applies them in order, so a new session wins.
  if (action === "callback") res.setHeader("Set-Cookie", dropped.map(expiredCookie));
}
