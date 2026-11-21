// app/next.config.js

/** @type {import('next').NextConfig} */
module.exports = {
  // No `typescript.ignoreBuildErrors`: a type error fails the production build,
  // not only `npm run validate` (SEC-07). The image is what ships, and it was
  // built from whatever typechecked or not. Next 16 no longer runs ESLint
  // during `build`, so the former `eslint` config key is gone too.

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // HSTS: force HTTPS for a year incl. subdomains. Browsers ignore it
          // over plain HTTP, so it's harmless before TLS is in place and
          // activates the moment the deployment is fronted by HTTPS. Do NOT
          // add `preload` until the domain is committed to HTTPS-forever.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // No Content-Security-Policy here. Pages get a per-request nonce
          // policy from src/proxy.ts (lib/contentSecurityPolicy.ts); a copy in
          // this block would land in the same response header map as the
          // proxy's, and which one won would depend on order and letter case.
        ],
      },
      {
        // The API's policy: /api/* is not a page and the proxy skips it (see
        // src/proxy.ts), so it gets a static policy with no unsafe keyword for
        // scripts. NextAuth's own pages under /api/auth use only an inline
        // <style>; object-src stays at default-src 'self' because a purchase
        // order's PDF opens inline from /api. The literal lives here and is not
        // imported from src/: the runtime image copies next.config.js without
        // src/ (Dockerfile).
        //
        // `:path+`, not `:path*`: the proxy runs on a bare /api (a not-found
        // page), and `*` would match it here too, giving it both policies.
        source: "/api/:path+",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },

  // Uploaded files (inventory photos, line drawings) live in /data/uploads,
  // outside public/, to avoid Next.js scanning the Docker volume on startup.
  // This rewrite lets existing /uploads/... URLs stored in the database
  // resolve through the file-serving API route.
  async rewrites() {
    return [{ source: "/uploads/:path*", destination: "/api/uploads/:path*" }];
  },
};
