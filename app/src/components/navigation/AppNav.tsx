"use client";

// /app/src/components/navigation/AppNav.tsx
//
// App Router top navigation. A deliberately lean sibling to the Pages-Router
// TopNav: it reuses the SAME getVisibleNavItems permission logic + branding,
// but uses next/navigation (usePathname/useRouter) instead of next/router, so
// it's valid inside App Router server layouts. TopNav stays untouched for the
// ~200 Pages-Router screens during the migration; ported pages use this.
//
// Notifications bell + impersonation dropdown are intentionally omitted here
// for now (they migrate with their own tRPC procedures); this covers the core
// nav + sign-out chrome that every ported page needs.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Button } from "@/components/ui/button";
import { getVisibleNavItems, type DbPermission, type NavItem } from "@/lib/auth/navPermissions";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";
import { useBranding } from "@/components/branding/BrandingProvider";

export function AppNav() {
  const { data: session } = useSession();
  const { effectiveRole } = useEffectiveRole();
  const branding = useBranding();
  const router = useRouter();
  const pathname = usePathname() ?? "/";

  const [navItems, setNavItems] = useState<NavItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadNav() {
      const [permsRes, featuresRes] = await Promise.allSettled([
        fetch("/api/admin/permissions"),
        fetch("/api/settings/features"),
      ]);

      let dbPerms: DbPermission[] | undefined;
      if (permsRes.status === "fulfilled" && permsRes.value.ok) {
        dbPerms = (await permsRes.value.json()).permissions as DbPermission[];
      }
      let features: Record<string, boolean> | undefined;
      if (featuresRes.status === "fulfilled" && featuresRes.value.ok) {
        features = (await featuresRes.value.json()).features as Record<string, boolean>;
      }
      if (!cancelled) setNavItems(getVisibleNavItems(effectiveRole, dbPerms, features));
    }
    loadNav();
    return () => {
      cancelled = true;
    };
    // Re-fetch on navigation (pathname) too, not just role change: AppNav lives
    // in the persistent (dashboard) layout, so without this a Settings -> Modules
    // toggle (or a permission change) wouldn't surface in the nav until a full
    // page reload. setNavItems only fires on success, so the old items stay
    // visible during the re-fetch (no flicker).
  }, [effectiveRole, pathname]);

  const isActive = useCallback(
    (href: string) => {
      if (href === "/") return pathname === "/";
      return pathname === href || pathname.startsWith(href + "/");
    },
    [pathname],
  );

  const handleSignOut = async () => {
    await signOut({ redirect: false });
    router.push("/auth/login");
  };

  return (
    <nav className="w-full border-b border-sh-gray bg-white shadow-sm font-serif">
      <div className="flex h-20 items-center justify-between px-4 sm:px-8">
        <Link href="/app" className="flex min-w-[140px] items-center gap-4">
          <BrandLogo
            appName={branding.appName}
            logoUrl={branding.logoUrl}
            width={56}
            height={56}
            className="rounded object-contain"
          />
        </Link>

        <div className="hidden items-center justify-center gap-8 text-xl text-sh-black md:flex">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`py-2 transition ${
                isActive(item.href)
                  ? "border-b-2 border-sh-gold font-semibold text-sh-blue"
                  : "underline-offset-4 hover:text-sh-blue hover:underline"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-4">
          {session?.user ? (
            <Button type="button" variant="secondary" onClick={handleSignOut}>
              Sign out
            </Button>
          ) : (
            <Link href="/auth/login">
              <Button type="button">Sign in</Button>
            </Link>
          )}
        </div>
      </div>

      {/* Mobile nav row */}
      <div className="flex flex-wrap gap-3 px-4 pb-3 text-sm text-sh-black md:hidden">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`py-1 ${
              isActive(item.href) ? "font-semibold text-sh-blue" : "text-sh-gray"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
