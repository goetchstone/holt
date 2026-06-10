// /app/src/components/cms/SiteHeader.tsx
//
// Public site header. Server component. Logo/name + CMS header menu (one level
// of dropdowns, CSS-only) + a staff sign-in link into the back-office.
//
// Two variants, driven by AppSettings themeMode: "light" (white bar, filled
// sign-in button) and "dark" (navy bar that blends into a dark site, logo +
// wordmark, outline "Staff login" button — the akritos.com chrome). Colors come
// from the brand tokens, so each tenant's palette applies in either mode.

import Link from "next/link";
import type { MenuItem } from "@/lib/cms/menu";
import type { ThemeMode } from "@/lib/appSettings";

interface SiteHeaderProps {
  appName: string;
  logoUrl: string | null;
  items: MenuItem[];
  variant?: ThemeMode;
}

export function SiteHeader({ appName, logoUrl, items, variant = "light" }: SiteHeaderProps) {
  const dark = variant === "dark";
  const link = dark
    ? "text-sm text-sh-stripe/70 transition hover:text-sh-gold"
    : "text-sm text-sh-gray transition hover:text-sh-navy";
  const dropdownPanel = dark ? "border-white/10 bg-sh-navy" : "border-black/10 bg-white";
  const dropdownLink = dark
    ? "px-4 py-2 text-sm text-sh-stripe/70 hover:bg-white/5 hover:text-sh-gold"
    : "px-4 py-2 text-sm text-sh-gray hover:bg-sh-linen hover:text-sh-navy";

  return (
    <header className={dark ? "bg-sh-navy" : "border-b border-black/10 bg-white"}>
      <div className="mx-auto flex max-w-screen-lg items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-3">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- configurable brand logo URL
            <img src={logoUrl} alt={appName} className="h-8 w-auto" />
          ) : null}
          {/* Dark sites pair the mark with a letterspaced wordmark (or show the
              name alone when there is no logo). Light keeps logo-or-name so
              wordmark-image logos aren't duplicated by a text name. */}
          {dark ? (
            <span className="font-serif text-base tracking-[0.2em] text-sh-stripe">{appName}</span>
          ) : !logoUrl ? (
            <span className="font-serif text-xl text-sh-navy">{appName}</span>
          ) : null}
        </Link>
        <nav className="flex items-center gap-6">
          {items.map((item, i) =>
            item.children.length > 0 ? (
              <div key={i} className="group relative">
                <span className={`cursor-default ${link}`}>{item.label}</span>
                <div
                  className={`absolute left-0 top-full z-10 hidden min-w-[180px] flex-col rounded-md border py-2 shadow-lg group-hover:flex ${dropdownPanel}`}
                >
                  {item.children.map((child, j) => (
                    <Link key={j} href={child.href} className={dropdownLink}>
                      {child.label}
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <Link key={i} href={item.href} className={link}>
                {item.label}
              </Link>
            ),
          )}
          {dark ? (
            <Link
              href="/app"
              className="rounded-[2px] border border-sh-stripe/30 px-4 py-2 text-sm text-sh-stripe transition hover:border-sh-gold hover:text-sh-gold"
            >
              Staff login
            </Link>
          ) : (
            <Link
              href="/app"
              className="rounded-md bg-sh-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-sh-blue"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
