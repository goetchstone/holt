"use client";

// /app/src/components/navigation/AppSidebar.tsx
//
// App Router left sidebar. Reuses the SAME getVisibleNavItems permission +
// feature logic as the old top-nav, rendered as a vertical, icon-led list.
// Persistent on lg+, a slide-in drawer on smaller screens (iPad portrait /
// phone). Self-contained: does its own nav fetch like AppNav did.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  BarChart3,
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
import { getVisibleNavItems, type DbPermission, type NavItem } from "@/lib/auth/navPermissions";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";
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
};

export function AppSidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const { effectiveRole } = useEffectiveRole();
  const branding = useBranding();
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
  }, [effectiveRole]);

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
        className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-black/10 bg-sh-navy text-white transition-transform duration-200 md:static md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Link
          href="/app"
          onClick={onClose}
          className="flex h-16 items-center gap-3 px-5 border-b border-white/10"
        >
          <BrandLogo
            appName={branding.appName}
            logoUrl={branding.logoUrl}
            width={32}
            height={32}
            className="rounded object-contain"
          />
          <span className="truncate font-serif text-lg">{branding.appName}</span>
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
