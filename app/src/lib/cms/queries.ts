// /app/src/lib/cms/queries.ts
//
// Server-side read access for the public CMS surface. Used by the (site) route
// group to fetch published content for the current organization. Draft content
// is never returned here -- only status === "PUBLISHED".

import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseBlocks, type ContentBlock } from "@/lib/cms/blocks";
import { parseMenuItems, type MenuItem, type MenuLocation } from "@/lib/cms/menu";

export interface RenderedPage {
  title: string;
  blocks: ContentBlock[];
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface PostSummary {
  slug: string;
  title: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  author: string | null;
  category: string | null;
  publishedAt: Date | null;
}

export interface RenderedPost extends RenderedPage {
  id: number;
  slug: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  author: string | null;
  category: string | null;
  publishedAt: Date | null;
}

export async function getHomePage(orgId: number = DEFAULT_ORG_ID): Promise<RenderedPage | null> {
  const page = await prisma.page.findFirst({
    where: { organizationId: orgId, isHome: true, status: "PUBLISHED" },
  });
  if (!page) return null;
  return {
    title: page.title,
    blocks: parseBlocks(page.blocks),
    seoTitle: page.seoTitle,
    seoDescription: page.seoDescription,
  };
}

export async function getPublishedPage(
  slug: string,
  orgId: number = DEFAULT_ORG_ID,
): Promise<RenderedPage | null> {
  const page = await prisma.page.findUnique({
    where: { organizationId_slug: { organizationId: orgId, slug } },
  });
  if (!page || page.status !== "PUBLISHED") return null;
  return {
    title: page.title,
    blocks: parseBlocks(page.blocks),
    seoTitle: page.seoTitle,
    seoDescription: page.seoDescription,
  };
}

export async function listPublishedPosts(orgId: number = DEFAULT_ORG_ID): Promise<PostSummary[]> {
  const posts = await prisma.post.findMany({
    where: { organizationId: orgId, status: "PUBLISHED" },
    orderBy: [{ publishedAt: "desc" }, { created: "desc" }],
    select: {
      slug: true,
      title: true,
      excerpt: true,
      coverImageUrl: true,
      author: true,
      category: true,
      publishedAt: true,
    },
  });
  return posts;
}

export async function getPublishedPost(
  slug: string,
  orgId: number = DEFAULT_ORG_ID,
): Promise<RenderedPost | null> {
  const post = await prisma.post.findUnique({
    where: { organizationId_slug: { organizationId: orgId, slug } },
  });
  if (!post || post.status !== "PUBLISHED") return null;
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    coverImageUrl: post.coverImageUrl,
    author: post.author,
    category: post.category,
    publishedAt: post.publishedAt,
    blocks: parseBlocks(post.blocks),
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
  };
}

export interface PublicComment {
  id: number;
  authorName: string;
  content: string;
  created: Date;
}

/** Approved comments for a post, oldest-first, for public render. */
export async function getApprovedComments(
  postId: number,
  orgId: number = DEFAULT_ORG_ID,
): Promise<PublicComment[]> {
  return prisma.blogComment.findMany({
    where: { postId, organizationId: orgId, status: "APPROVED" },
    orderBy: { created: "asc" },
    select: { id: true, authorName: true, content: true, created: true },
  });
}

/** Absolute URL for a public path, used for canonical + Open Graph tags. */
export function siteUrl(path = ""): string {
  const base = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return path ? `${base}/${path.replace(/^\/+/, "")}` : base;
}

export async function getMenu(
  location: MenuLocation,
  orgId: number = DEFAULT_ORG_ID,
): Promise<MenuItem[]> {
  const menu = await prisma.menu.findUnique({
    where: { organizationId_location: { organizationId: orgId, location } },
  });
  return parseMenuItems(menu?.items ?? null);
}

export type { ContentBlock };
