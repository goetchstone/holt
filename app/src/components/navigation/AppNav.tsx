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
import { useCallback, useMemo } from "react";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Button } from "@/components/ui/button";
import { getVisibleNavItems, resolveViewerPermissions } from "@/lib/auth/navPermissions";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";
import { useFeatures } from "@/lib/hooks/useFeatures";
import { useBranding } from "@/components/branding/BrandingProvider";

export function AppNav() {
  const { data: session } = useSession();
  const { isImpersonating, impersonatedRole } = useEffectiveRole();
  const branding = useBranding();
  const router = useRouter();
  const pathname = usePathname() ?? "/";

  // Permissions ride in on the session — no per-navigation fetch. Feature
  // modules still come from the API, keyed on pathname so a Settings -> Modules
  // toggle reaches the persistent layout without a full reload.
  const { features } = useFeatures(pathname);

  const navItems = useMemo(() => {
    if (!session) return [];
    const permissions = resolveViewerPermissions(
      session,
      isImpersonating ? impersonatedRole : null,
    );
    return getVisibleNavItems(permissions, features ?? undefined);
  }, [session, isImpersonating, impersonatedRole, features]);

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
