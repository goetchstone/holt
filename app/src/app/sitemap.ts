// /app/src/app/sitemap.ts
//
// Dynamic sitemap.xml generated from published CMS pages + posts so search
// engines re-discover every public URL. Critical for preserving SEO authority
// when an existing site's pages are recreated in the CMS at the same slugs.
// force-dynamic keeps the DB query out of the build (mirrors the (site) pages).

import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";

export const dynamic = "force-dynamic";

function baseUrl(): string {
  return (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = baseUrl();
  const [pages, posts] = await Promise.all([
    prisma.page.findMany({
      where: { organizationId: DEFAULT_ORG_ID, status: "PUBLISHED" },
      select: { slug: true, isHome: true, updated: true, publishedAt: true },
    }),
    prisma.post.findMany({
      where: { organizationId: DEFAULT_ORG_ID, status: "PUBLISHED" },
      select: { slug: true, updated: true, publishedAt: true },
    }),
  ]);

  const pageEntries: MetadataRoute.Sitemap = pages.map((p) => ({
    url: p.isHome ? base : `${base}/${p.slug}`,
    lastModified: p.updated ?? p.publishedAt ?? undefined,
  }));

  const postEntries: MetadataRoute.Sitemap = posts.map((p) => ({
    url: `${base}/blog/${p.slug}`,
    lastModified: p.updated ?? p.publishedAt ?? undefined,
  }));

  return [{ url: `${base}/blog` }, ...pageEntries, ...postEntries];
}
