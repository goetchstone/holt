// /app/src/lib/auth/safeCallbackUrl.ts
//
// Where the login page may send someone after they sign in.
//
// `?callbackUrl=` arrives from the address bar, so anyone can craft a login
// link carrying one. The page hands it to router.push() and to NextAuth's
// signIn(), and NextAuth's client falls back to `window.location.href =
// callbackUrl` whenever the server returns no URL of its own. Used raw, that
// is an open redirect (`https://evil.example`, `//evil.example`) and, for a
// `javascript:` URL, script running on our origin (CodeQL js/xss #6 and
// js/client-side-unvalidated-url-redirection #9).
//
// The rule: resolve the value against our own origin and keep it only if it
// is still our origin. The result is rebuilt as `origin + path`, never the raw
// input, so a path that the URL parser normalises to `//host` (`/.//host`)
// stays a path on our host instead of becoming protocol-relative.

/** Where a sign-in lands when no usable callbackUrl was given. */
export const DEFAULT_CALLBACK_PATH = "/app";

/**
 * A same-origin absolute URL for `raw`, or `origin + DEFAULT_CALLBACK_PATH`.
 *
 * `raw` is whatever `router.query.callbackUrl` held: a string, an array when
 * the parameter was repeated, or undefined. `origin` is the page's own origin
 * (`window.location.origin`), without a trailing slash.
 */
export function safeCallbackUrl(raw: unknown, origin: string): string {
  const fallback = `${origin}${DEFAULT_CALLBACK_PATH}`;
  if (typeof raw !== "string" || raw === "") return fallback;

  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  return `${origin}${url.pathname}${url.search}${url.hash}`;
}
