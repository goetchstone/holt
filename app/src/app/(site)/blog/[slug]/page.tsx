// /app/src/app/(site)/blog/[slug]/page.tsx
//
// Public blog post. Renders the post's blocks below a title/byline header.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAppSettings } from "@/lib/appSettings";
import { getPublishedPost, getApprovedComments, siteUrl } from "@/lib/cms/queries";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { BlockRenderer } from "@/components/cms/BlockRenderer";
import { CommentForm } from "@/components/cms/CommentForm";

interface PostParams {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PostParams): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedPost(slug);
  if (!post) return {};
  const title = post.seoTitle || post.title;
  const description = post.seoDescription || post.excerpt || undefined;
  return {
    title,
    description,
    alternates: { canonical: siteUrl(`blog/${slug}`) },
    openGraph: {
      title,
      description,
      url: siteUrl(`blog/${slug}`),
      type: "article",
      images: post.coverImageUrl ? [post.coverImageUrl] : undefined,
    },
  };
}

export default async function BlogPost({ params }: PostParams) {
  const { slug } = await params;
  const [settings, post] = await Promise.all([getAppSettings(), getPublishedPost(slug)]);
  if (!post) notFound();

  const commentsEnabled = isFeatureEnabled(settings.features, "blogComments");
  const comments = commentsEnabled ? await getApprovedComments(post.id) : [];

  const dateLabel = post.publishedAt
    ? new Intl.DateTimeFormat(settings.locale, {
        dateStyle: "long",
        timeZone: settings.timezone,
      }).format(post.publishedAt)
    : null;

  return (
    <article className="mx-auto max-w-screen-md px-6 py-12">
      <header className="mb-8 text-center">
        <h1 className="font-serif text-4xl text-sh-navy">{post.title}</h1>
        <p className="mt-2 text-sm text-sh-gray">
          {[post.author, dateLabel].filter(Boolean).join(" · ")}
        </p>
      </header>
      <BlockRenderer blocks={post.blocks} />

      {commentsEnabled ? (
        <section className="mt-12 border-t border-black/10 pt-8">
          <h2 className="font-serif text-2xl text-sh-navy">Comments</h2>
          {comments.length === 0 ? (
            <p className="mt-3 text-sh-gray">Be the first to comment.</p>
          ) : (
            <ul className="mt-6 space-y-6">
              {comments.map((c) => (
                <li key={c.id} className="border-b border-black/5 pb-4">
                  <p className="text-sm font-medium text-sh-navy">{c.authorName}</p>
                  <p className="text-xs text-sh-gray">
                    {new Intl.DateTimeFormat(settings.locale, {
                      dateStyle: "medium",
                      timeZone: settings.timezone,
                    }).format(c.created)}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sh-black">{c.content}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-8">
            <h3 className="font-serif text-lg text-sh-navy">Leave a comment</h3>
            <div className="mt-4">
              <CommentForm postId={post.id} />
            </div>
          </div>
        </section>
      ) : null}
    </article>
  );
}
