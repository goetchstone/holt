"use client";

// /app/src/components/layout/CardGrid.tsx
//
// Chrome-free card-grid hub for App Router pages; the (dashboard) layout
// supplies the chrome. The cards arrive already filtered by the hub page, on
// the server, to the ones whose page the viewer may open (lib/auth/hubCards.ts,
// View as included). This component only hides a card whose feature module the
// deployment has switched off.

import Link from "next/link";
import { useFeatures } from "@/lib/hooks/useFeatures";

export type CardGridItem = {
  title: string;
  description: string;
  href: string;
  // Optional gating feature-module key (lib/featureCatalog). Hidden when the
  // deployment has that module switched off in AppSettings.features.
  feature?: string;
};

export default function CardGrid({
  title,
  items,
}: Readonly<{ title: string; items: CardGridItem[] }>) {
  const { enabled } = useFeatures();

  const visibleItems = items.filter((item) => !item.feature || enabled(item.feature));

  return (
    <div className="space-y-6 py-2 font-serif">
      <h1 className="text-2xl font-semibold text-brand-blue">{title}</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {visibleItems.map((item) => (
          <Link
            href={item.href}
            key={item.href}
            className="block rounded-lg border border-brand-gray/20 bg-white p-5 shadow-md transition hover:shadow-lg"
          >
            <h2 className="mb-1 text-lg font-semibold text-brand-black">{item.title}</h2>
            <p className="text-sm text-brand-gray">{item.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
