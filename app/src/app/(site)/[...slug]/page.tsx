// /app/src/app/(site)/[...slug]/page.tsx
//
// Public CMS page by slug. Static back-office (/app/*), portal, print and api
// routes are more specific than this catch-all, so they always win; everything
// else resolves to a published CMS page or 404.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublishedPage, siteUrl } from "@/lib/cms/queries";
import { BlockRenderer } from "@/components/cms/BlockRenderer";

interface PageParams {
  params: Promise<{ slug: string[] }>;
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const path = slug.join("/");
  const page = await getPublishedPage(path);
  if (!page) return {};
  const title = page.seoTitle || page.title;
  const description = page.seoDescription || undefined;
  return {
    title,
    description,
    alternates: { canonical: siteUrl(path) },
    openGraph: { title, description, url: siteUrl(path), type: "website" },
  };
}

export default async function CmsPage({ params }: PageParams) {
  const { slug } = await params;
  const page = await getPublishedPage(slug.join("/"));
  if (!page) notFound();
  return (
    <article className="py-4">
      <BlockRenderer blocks={page.blocks} />
    </article>
  );
}
