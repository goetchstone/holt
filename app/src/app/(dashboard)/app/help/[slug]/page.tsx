// /app/src/app/(dashboard)/app/help/[slug]/page.tsx
//
// One help article (GAP-30). Its HTML is sanitized by lib/help/articles.ts.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { readHelpArticle } from "@/lib/help/articles";
import { HELP_PROSE } from "@/components/help/helpProse";

export default async function HelpArticlePage({
  params,
}: Readonly<{ params: Promise<{ slug: string }> }>) {
  await requirePage(undefined, { permission: "staff.self" });
  const { slug } = await params;
  const article = await readHelpArticle(slug);
  if (!article) notFound();
  return (
    <article className="max-w-3xl space-y-4">
      <Link href="/app/help" className="text-sm text-brand-blue underline">
        All help articles
      </Link>
      <h1 className="font-serif text-2xl font-semibold text-brand-blue">{article.title}</h1>
      <div className={HELP_PROSE} dangerouslySetInnerHTML={{ __html: article.html }} />
    </article>
  );
}
