// /app/src/app/(site)/blog/page.tsx
//
// Public blog index. Lists published posts newest-first.

import type { Metadata } from "next";
import Link from "next/link";
import { getAppSettings } from "@/lib/appSettings";
import { listPublishedPosts } from "@/lib/cms/queries";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getAppSettings();
  return { title: `Blog | ${settings.appName}` };
}

export default async function BlogIndex() {
  const [settings, posts] = await Promise.all([getAppSettings(), listPublishedPosts()]);
  const fmt = new Intl.DateTimeFormat(settings.locale, {
    dateStyle: "long",
    timeZone: settings.timezone,
  });

  return (
    <div className="mx-auto max-w-screen-lg px-6 py-12">
      <h1 className="font-serif text-4xl text-sh-navy">Blog</h1>
      {posts.length === 0 ? (
        <p className="mt-6 text-sh-gray">No posts published yet.</p>
      ) : (
        <div className="mt-8 grid gap-10 sm:grid-cols-2">
          {posts.map((post) => (
            <article key={post.slug} className="flex flex-col">
              {post.coverImageUrl ? (
                <Link href={`/blog/${post.slug}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- CMS cover image URL */}
                  <img
                    src={post.coverImageUrl}
                    alt={post.title}
                    className="h-48 w-full rounded-md object-cover"
                  />
                </Link>
              ) : null}
              <h2 className="mt-4 font-serif text-2xl text-sh-navy">
                <Link href={`/blog/${post.slug}`} className="hover:underline">
                  {post.title}
                </Link>
              </h2>
              <p className="mt-1 text-sm text-sh-gray">
                {[post.author, post.publishedAt ? fmt.format(post.publishedAt) : null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {post.excerpt ? <p className="mt-2 text-sh-gray">{post.excerpt}</p> : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
