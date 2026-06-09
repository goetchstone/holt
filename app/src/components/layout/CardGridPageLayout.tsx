// /app/src/components/layout/CardGridPageLayout.tsx

import MainLayout from "@/components/layout/MainLayout";
import Link from "next/link";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";

export type CardGridItem = {
  title: string;
  description: string;
  href: string;
  roles?: string[];
};

type Props = {
  title: string;
  items: CardGridItem[];
};

export default function CardGridPageLayout({ title, items }: Props) {
  const { effectiveRole } = useEffectiveRole();

  // SUPER_ADMIN sees every card. Otherwise standard inclusion match.
  // Without this, every hub page (Reports, Admin, Sales, Tools, etc.)
  // hides ALL cards from SUPER_ADMIN because the roles arrays were
  // written with `["ADMIN", ...]` and don't list SUPER_ADMIN. Origin
  // 2026-05-19, post-deploy of PR #297.
  const visibleItems = items.filter((item) => {
    if (!item.roles || item.roles.length === 0) return true;
    if (effectiveRole === "SUPER_ADMIN") return true;
    return item.roles.includes(effectiveRole);
  });

  return (
    <MainLayout>
      <div className="py-2 space-y-6 font-serif">
        <h1 className="text-2xl text-sh-blue font-semibold">{title}</h1>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {visibleItems.map((item) => (
            <Link
              href={item.href}
              key={item.href}
              className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5 hover:shadow-lg transition block"
            >
              <h2 className="text-lg text-sh-black font-semibold mb-1">{item.title}</h2>
              <p className="text-sh-gray text-sm">{item.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </MainLayout>
  );
}
