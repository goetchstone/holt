// /app/src/lib/auth/endSession.ts
//
// Signing out so that it stays signed out. Every sign-out in the app goes
// through here (__tests__/lib/auth/endSession.test.ts holds them to it).
//
// next-auth's signOut clears the session cookie, but every API response
// re-issues that cookie (getServerSession), so a request the screen sent just
// before -- the Up Board's refresh, the notification poll -- can answer just
// after and put the session back. Seen 2026-10-31 on GAP-27's automatic
// sign-out: the screen went to sign-in and the session was still there; on a
// session without an idle time it would have lasted 30 days. A screen can't
// stop its own requests, but the sign-in screen can look once it has replaced
// that screen: by then the old screen's requests have answered or been
// abandoned, so a session still there was put back, and it is signed out.
//
// A sessionStorage mark, set only here, asks the sign-in screen to look, so a
// link to /auth/login can't sign anyone out (next-auth's CSRF check on sign-out
// exists to stop exactly that).

import { getSession, signOut } from "next-auth/react";

const MARK = "holt:signingOut";
/** Sign-outs the sign-in screen tries before giving up on a stubborn session. */
const CONFIRM_TRIES = 3;

function setMark(): void {
  try {
    window.sessionStorage.setItem(MARK, "1");
  } catch {
    // Storage blocked: the server's own expiry is the backstop.
  }
}

function takeMark(): boolean {
  try {
    const marked = window.sessionStorage.getItem(MARK) === "1";
    window.sessionStorage.removeItem(MARK);
    return marked;
  } catch {
    return false;
  }
}

/** Sign out, then go to `url` -- the sign-in screen, which makes sure of it. */
export async function signOutTo(url: string): Promise<void> {
  setMark();
  await signOut({ redirect: false });
  window.location.assign(url);
}

/** The session ended in another tab: go to the sign-in screen, which makes sure of it. */
export function leaveTo(url: string): void {
  setMark();
  window.location.assign(url);
}

/** On the sign-in screen: finish a sign-out that a late response undid. */
export async function confirmSignedOut(): Promise<void> {
  if (!takeMark()) return;
  // The sign-in screen's own first session read can race the sign-out too, so
  // look again until nothing comes back.
  for (let i = 0; i < CONFIRM_TRIES && (await getSession()); i++) {
    await signOut({ redirect: false });
  }
}
