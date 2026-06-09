// /app/src/components/cms/SiteFooter.tsx
//
// Public site footer. Server component. CMS footer menu + copyright line.

import Link from "next/link";
import type { MenuItem } from "@/lib/cms/menu";

interface SiteFooterProps {
  appName: string;
  items: MenuItem[];
  year: number;
}

export function SiteFooter({ appName, items, year }: SiteFooterProps) {
  return (
    <footer className="mt-16 border-t border-black/10 bg-sh-linen">
      <div className="mx-auto flex max-w-screen-lg flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-sh-gray">
          &copy; {year} {appName}
        </p>
        {items.length > 0 ? (
          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            {items.map((item, i) => (
              <Link
                key={i}
                href={item.href}
                className="text-sm text-sh-gray transition hover:text-sh-navy"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
    </footer>
  );
}
