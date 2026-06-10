// app/next.config.js

/** @type {import('next').NextConfig} */
module.exports = {
  // Skip TypeScript errors during builds; we run typecheck (and ESLint) separately
  // via `npm run validate`. Next 16 no longer runs ESLint during `build`, so the
  // former `eslint` config key was removed (it is now an unrecognized option).
  typescript: {
    ignoreBuildErrors: true,
  },

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
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
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
