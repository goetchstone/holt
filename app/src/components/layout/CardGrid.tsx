"use client";

// /app/src/components/layout/CardGrid.tsx
//
// Chrome-free card-grid hub for App Router pages. Same card markup + role
// filtering as the Pages-Router CardGridPageLayout, but without MainLayout — the
// (dashboard) layout supplies the chrome. Role filtering runs client-side via
// useEffectiveRole so impersonation is honored. SUPER_ADMIN sees every card.

import Link from "next/link";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";
import { useFeatures } from "@/lib/hooks/useFeatures";

export type CardGridItem = {
  title: string;
  description: string;
  href: string;
  roles?: string[];
  // Optional gating feature-module key (lib/featureCatalog). Hidden when the
  // deployment has that module switched off in AppSettings.features.
  feature?: string;
};

export default function CardGrid({
  title,
  items,
}: Readonly<{ title: string; items: CardGridItem[] }>) {
  const { effectiveRole } = useEffectiveRole();
  const { enabled } = useFeatures();

  const visibleItems = items.filter((item) => {
    if (item.feature && !enabled(item.feature)) return false;
    if (!item.roles || item.roles.length === 0) return true;
    if (effectiveRole === "SUPER_ADMIN") return true;
    return item.roles.includes(effectiveRole);
  });

  return (
    <div className="space-y-6 py-2 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue">{title}</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {visibleItems.map((item) => (
          <Link
            href={item.href}
            key={item.href}
            className="block rounded-lg border border-sh-gray/20 bg-white p-5 shadow-md transition hover:shadow-lg"
          >
            <h2 className="mb-1 text-lg font-semibold text-sh-black">{item.title}</h2>
            <p className="text-sm text-sh-gray">{item.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
