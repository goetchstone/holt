"use client";

// /app/src/components/navigation/AppSidebar.tsx
//
// App Router left sidebar. Reuses the SAME getVisibleNavItems permission +
// feature logic as the old top-nav, rendered as a vertical, icon-led list.
// Persistent on lg+, a slide-in drawer on smaller screens (iPad portrait /
// phone). The Admin entry carries a count of getting-started items still to do
// (lib/gettingStarted.ts) for viewers who can act on them.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useMemo } from "react";
import {
  BarChart3,
  Clock,
  Hammer,
  LayoutDashboard,
  LifeBuoy,
  Package,
  Settings,
  ShoppingCart,
  Truck,
  Warehouse,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { getVisibleNavItems, resolveViewerPermissions } from "@/lib/auth/navPermissions";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";
import { useFeatures } from "@/lib/hooks/useFeatures";
import { useGettingStartedRemaining } from "@/lib/hooks/useGettingStartedRemaining";
import { useBranding } from "@/components/branding/BrandingProvider";

// Label -> icon. Unknown labels fall back to a generic icon.
const NAV_ICONS: Record<string, LucideIcon> = {
  Sales: ShoppingCart,
  Service: Wrench,
  Purchasing: Truck,
  Warehouse: Warehouse,
  Inventory: Package,
  Reports: BarChart3,
  Admin: Settings,
  Tools: Hammer,
  Helpdesk: LifeBuoy,
  // Time is on the baseline now, so every signed-in staff member sees it and it
  // no longer falls through to the generic icon.
  Time: Clock,
};

export function AppSidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const { data: session } = useSession();
  const { isImpersonating, impersonatedRole } = useEffectiveRole();
  const branding = useBranding();
  const pathname = usePathname() ?? "/";
  const { features } = useFeatures();

  const permissions = useMemo(() => {
    if (!session) return [];
    return resolveViewerPermissions(session, isImpersonating ? impersonatedRole : null);
  }, [session, isImpersonating, impersonatedRole]);
  const navItems = useMemo(
    () => (session ? getVisibleNavItems(permissions, features ?? undefined) : []),
    [session, permissions, features],
  );
  // The checklist's own key: the hub card and its API are both on admin.settings.
  const setupRemaining = useGettingStartedRemaining(
    permissions.includes("admin.settings"),
    pathname,
  );

  const isActive = useCallback(
    (href: string) => pathname === href || pathname.startsWith(href + "/"),
    [pathname],
  );

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-black/10 bg-brand-navy text-white transition-transform duration-200 md:static md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* The name is written out beside the mark, so the mark must never be
            the name too. BrandLogo's no-logo fallback is a full-size wordmark,
            and here it rendered navy on the navy sidebar: invisible, but still
            taking most of the 240px and leaving the visible name to truncate
            to "Holt H...". Without a logo the mark is the name's initial. */}
        <Link
          href="/app"
          onClick={onClose}
          title={branding.appName}
          className="flex h-16 items-center gap-3 px-5 border-b border-white/10"
        >
          {branding.logoUrl ? (
            <BrandLogo
              appName={branding.appName}
              logoUrl={branding.logoUrl}
              width={32}
              height={32}
              className="h-8 w-8 shrink-0 rounded object-contain"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/15 font-serif text-base font-semibold"
            >
              {branding.appName.trim().charAt(0).toUpperCase()}
            </span>
          )}
          <span className="line-clamp-2 min-w-0 font-serif text-base leading-tight">
            {branding.appName}
          </span>
        </Link>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-1">
            {navItems.map((item) => {
              const Icon = NAV_ICONS[item.label] ?? LayoutDashboard;
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onClose}
                    className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
                      active
                        ? "bg-white/15 font-medium text-white"
                        : "text-white/75 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {item.href === "/app/admin" && setupRemaining > 0 ? (
                      <span
                        title={`${setupRemaining} getting-started ${setupRemaining === 1 ? "step" : "steps"} left`}
                        className="ml-auto rounded-full bg-amber-400 px-1.5 text-[11px] font-semibold leading-5 text-brand-black"
                      >
                        {setupRemaining}
                        <span className="sr-only"> getting-started steps left</span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-white/10 px-5 py-3 text-xs text-white/40">
          {branding.appName}
        </div>
      </aside>
    </>
  );
}
