"use client";

// /app/src/app/(dashboard)/app/help/HelpIndexView.tsx
//
// The help articles, with a search over their titles and words (GAP-30).

import { useMemo, useState } from "react";
import Link from "next/link";
import { matchingArticles } from "@/lib/help/catalog";

interface ArticleCard {
  slug: string;
  title: string;
  summary: string;
  text: string;
}

export function HelpIndexView({ articles }: Readonly<{ articles: ArticleCard[] }>) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => matchingArticles(articles, query), [articles, query]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-brand-blue">Help</h1>
        <p className="text-sm text-brand-gray">
          How to do things in Holt. The ? at the top of any screen opens its article.
        </p>
      </div>
      <label className="block max-w-md text-sm">
        <span className="mb-1 block text-brand-gray">Search help</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="For example: refund, price book"
          className="min-h-[44px] w-full rounded border border-gray-300 px-3"
        />
      </label>
      {shown.length === 0 ? (
        <p className="text-sm text-brand-gray">No article matches that.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {shown.map((a) => (
            <li key={a.slug}>
              <Link
                href={`/app/help/${a.slug}`}
                className="block h-full rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm transition hover:border-brand-blue"
              >
                <span className="block font-serif text-lg font-semibold text-brand-blue">
                  {a.title}
                </span>
                <span className="mt-1 block text-sm text-brand-gray">{a.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
