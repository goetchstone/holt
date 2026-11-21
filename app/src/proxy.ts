// /app/src/proxy.ts
//
// Next 16's proxy (the file convention formerly called middleware). It does one
// thing: give every page request a fresh nonce and the Content-Security-Policy
// built from it (lib/contentSecurityPolicy.ts). The policy goes on the
// response, for the browser, and on the request, where Next reads the nonce
// back and stamps its scripts; x-nonce carries it to pages/_document.tsx for
// the Pages Router sign-in screens.
//
// Nothing else belongs here. Authentication stays in requirePage and the route
// guards, which run where the data is read.
//
// The matcher skips /api/ (next.config.js gives it a static policy). That
// exclusion is load-bearing: Next buffers the body of every request a proxy
// handles in memory and keeps only the first 10MB, while nginx admits 300MB
// uploads to /api. It is 'api/' rather than Next's example 'api' so a page
// such as /apiary still gets a policy. Prefetches are skipped, as Next's guide
// recommends.

import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce } from "@/lib/contentSecurityPolicy";

export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static/|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
