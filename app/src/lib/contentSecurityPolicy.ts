// /app/src/lib/contentSecurityPolicy.ts
//
// The Content-Security-Policy every page answers with. src/proxy.ts mints a
// nonce per request and sends this policy on the response, and on the request,
// where Next reads the nonce back out of it and stamps its own scripts: the App
// Router does that by itself, and the Pages Router sign-in screens get it from
// pages/_document.tsx. /api/* is not a page and carries a static policy from
// next.config.js instead. docs/DECISIONS.md entry 62 records why.
//
// Why each directive is what it is:
// - script-src runs a script only if it carries this request's nonce or was
//   inserted by one that does. 'strict-dynamic' is what admits the chunks the
//   nonced Turbopack runtime loads; 'self' is the fallback for a browser
//   without CSP level 3, which ignores 'strict-dynamic'. 'unsafe-eval' is
//   added in development only, where React needs eval to rebuild server
//   error stacks; production needs none.
// - style-src keeps 'unsafe-inline' and takes no nonce, unlike Next's guide: a
//   browser that sees a nonce in style-src ignores 'unsafe-inline', and the app
//   needs it for style={} props, the theme and print <style> blocks, and the
//   <style> react-toastify injects.
// - frame-src admits the CMS embed providers (lib/cms/embedHosts.ts), the same
//   list the sanitizer keeps iframes from.
// - base-uri 'self' stops an injected <base> from re-pointing the nonced,
//   root-relative script URLs at another host.
// - form-action 'self': the only native form in the app is a same-origin GET
//   (the audit trail's filter).
// - No upgrade-insecure-requests: CI and an install not yet behind TLS serve
//   plain http, and HSTS already holds a TLS deployment to https.
// - No report-uri: nothing collects reports.

import { CMS_EMBED_HOSTNAMES } from "@/lib/cms/embedHosts";

/** A fresh nonce for one request. Base64, which Next's nonce pattern always accepts. */
export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

/** The policy for a page whose scripts carry `nonce`; `dev` adds 'unsafe-eval'. */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  const embeds = CMS_EMBED_HOSTNAMES.map((host) => `https://${host}`).join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src 'self' ${embeds}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
