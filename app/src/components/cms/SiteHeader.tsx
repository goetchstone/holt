// /app/src/components/cms/SiteHeader.tsx
//
// Public site header. Server component. Logo/name + CMS header menu (one level
// of dropdowns, CSS-only) + a staff sign-in link into the back-office.

import Link from "next/link";
import type { MenuItem } from "@/lib/cms/menu";

interface SiteHeaderProps {
  appName: string;
  logoUrl: string | null;
  items: MenuItem[];
}

export function SiteHeader({ appName, logoUrl, items }: SiteHeaderProps) {
  return (
    <header className="border-b border-black/10 bg-white">
      <div className="mx-auto flex max-w-screen-lg items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-3">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- configurable brand logo URL
            <img src={logoUrl} alt={appName} className="h-8 w-auto" />
          ) : (
            <span className="font-serif text-xl text-sh-navy">{appName}</span>
          )}
        </Link>
        <nav className="flex items-center gap-6">
          {items.map((item, i) =>
            item.children.length > 0 ? (
              <div key={i} className="group relative">
                <span className="cursor-default text-sm text-sh-gray">{item.label}</span>
                <div className="absolute left-0 top-full z-10 hidden min-w-[180px] flex-col rounded-md border border-black/10 bg-white py-2 shadow-lg group-hover:flex">
                  {item.children.map((child, j) => (
                    <Link
                      key={j}
                      href={child.href}
                      className="px-4 py-2 text-sm text-sh-gray hover:bg-sh-linen hover:text-sh-navy"
                    >
                      {child.label}
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <Link
                key={i}
                href={item.href}
                className="text-sm text-sh-gray transition hover:text-sh-navy"
              >
                {item.label}
              </Link>
            ),
          )}
          <Link
            href="/app"
            className="rounded-md bg-sh-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-sh-blue"
          >
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}
