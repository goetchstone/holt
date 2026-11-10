// /app/src/app/(dashboard)/app/help/page.tsx
//
// Help (GAP-30, DECISIONS 54): every how-to article, with search. Read inside the app
// only; every staff member holds staff.self.

import { requirePage } from "@/lib/auth/requirePage";
import { HELP_ARTICLES } from "@/lib/help/catalog";
import { readHelpArticle } from "@/lib/help/articles";
import { HelpIndexView } from "./HelpIndexView";

export default async function HelpPage() {
  await requirePage(undefined, { permission: "staff.self" });
  const articles = await Promise.all(HELP_ARTICLES.map((a) => readHelpArticle(a.slug)));
  return (
    <HelpIndexView
      articles={articles.flatMap((a) =>
        a ? [{ slug: a.slug, title: a.title, summary: a.summary, text: a.text }] : [],
      )}
    />
  );
}
