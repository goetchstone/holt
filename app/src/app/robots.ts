// /app/src/app/robots.ts
//
// robots.txt: allow the public site, keep the back-office, API, and auth out of
// the index. Points crawlers at the dynamic sitemap.

import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/app/", "/api/", "/auth/", "/portal/", "/print/"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
