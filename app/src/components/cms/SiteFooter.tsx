// /app/src/components/cms/SiteFooter.tsx
//
// Public site footer. Server component. CMS footer menu + copyright line.
// Variant mirrors SiteHeader: "dark" blends into a dark site on the brand
// tokens; "light" is the linen default.

import Link from "next/link";
import type { MenuItem } from "@/lib/cms/menu";
import type { ThemeMode } from "@/lib/appSettings";

interface SiteFooterProps {
  appName: string;
  items: MenuItem[];
  year: number;
  variant?: ThemeMode;
}

export function SiteFooter({ appName, items, year, variant = "light" }: SiteFooterProps) {
  const dark = variant === "dark";
  const text = dark ? "text-sm text-sh-stripe/50" : "text-sm text-sh-gray";
  const link = dark
    ? "text-sm text-sh-stripe/50 transition hover:text-sh-gold"
    : "text-sm text-sh-gray transition hover:text-sh-navy";

  return (
    <footer
      className={
        dark ? "border-t border-white/10 bg-sh-navy" : "mt-16 border-t border-black/10 bg-sh-linen"
      }
    >
      <div className="mx-auto flex max-w-screen-lg flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <p className={text}>
          &copy; {year} {appName}
        </p>
        {items.length > 0 ? (
          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            {items.map((item, i) => (
              <Link key={i} href={item.href} className={link}>
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
    </footer>
  );
}
