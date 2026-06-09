// /app/src/components/navigation/TopNav.tsx

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/router";
import { useCallback, useEffect, useRef, useState } from "react";
import { getVisibleNavItems, type DbPermission, type NavItem } from "@/lib/auth/navPermissions";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";
import { useBranding } from "@/components/branding/BrandingProvider";
import { Bell } from "lucide-react";

interface ClosedIssue {
  number: number;
  title: string;
  closedAt: string;
}

interface NotificationData {
  openCount: number;
  recentlyClosed: ClosedIssue[];
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs === 1 ? "" : "s"} ago`;
  if (diffDays === 1) return "yesterday";
  return `${diffDays} days ago`;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;

function NotificationBell() {
  const [data, setData] = useState<NotificationData | null>(null);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/issues");
      if (res.ok) {
        const json: NotificationData = await res.json();
        setData(json);
      }
    } catch {
      // Silently ignore fetch errors
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // Dismiss on click outside
  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const openCount = data?.openCount ?? 0;
  const recentlyClosed = data?.recentlyClosed ?? [];

  const handleFeedbackClick = () => {
    setOpen(false);
    // Trigger the floating FeedbackButton by dispatching a custom event
    globalThis.dispatchEvent(new CustomEvent("open-feedback"));
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((prev) => !prev)}
        className="relative flex items-center justify-center w-10 h-10 rounded-full hover:bg-sh-linen transition-colors"
        aria-label="Notifications"
      >
        <Bell size={20} className="text-sh-gray" />
        {openCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-sh-gold text-white text-[10px] font-semibold leading-none px-1">
            {openCount > 99 ? "99+" : openCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white border border-sh-gray/20 rounded-lg shadow-lg z-50 font-serif"
        >
          <div className="px-4 py-3 border-b border-sh-gray/10">
            <h3 className="text-sm font-semibold text-sh-blue">Updates</h3>
          </div>

          <div className="max-h-72 overflow-y-auto">
            {recentlyClosed.length > 0 && (
              <div className="px-4 py-3">
                <p className="text-xs font-medium text-sh-gray uppercase tracking-wide mb-2">
                  Recently Fixed
                </p>
                <ul className="space-y-2">
                  {recentlyClosed.map((issue) => (
                    <li key={issue.number} className="flex flex-col gap-0.5">
                      <span className="text-sm text-sh-black truncate" title={issue.title}>
                        {issue.title}
                      </span>
                      <span className="text-xs text-sh-gray">
                        {formatRelativeTime(issue.closedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="px-4 py-3 border-t border-sh-gray/10">
              <p className="text-sm text-sh-gray">Open Issues ({openCount})</p>
            </div>
          </div>

          <div className="px-4 py-3 border-t border-sh-gray/10">
            <button
              onClick={handleFeedbackClick}
              className="text-sm text-sh-blue hover:underline underline-offset-2"
            >
              Submit Feedback
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const IMPERSONATE_ROLES = [
  "DESIGNER",
  "REGISTER",
  "MANAGER",
  "WAREHOUSE",
  "INSTALLER",
  "MARKETING",
];

export default function TopNav() {
  const { data: session } = useSession();
  const router = useRouter();
  // isImpersonating + impersonatedRole now read by the global
  // <ImpersonationBanner /> in _app.tsx; TopNav only needs the role
  // values to gate its View-as dropdown and decide which nav items to
  // show.
  const { effectiveRole, realRole, isImpersonating } = useEffectiveRole();
  const branding = useBranding();

  const [navItems, setNavItems] = useState<NavItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadPermissions() {
      // Role overrides and enabled feature modules are independent optional
      // inputs to the pure getVisibleNavItems filter; fetch both in parallel.
      const [permsRes, featuresRes] = await Promise.allSettled([
        fetch("/api/admin/permissions"),
        fetch("/api/settings/features"),
      ]);

      let dbPerms: DbPermission[] | undefined;
      if (permsRes.status === "fulfilled" && permsRes.value.ok) {
        const data = await permsRes.value.json();
        dbPerms = data.permissions as DbPermission[];
      }

      let features: Record<string, boolean> | undefined;
      if (featuresRes.status === "fulfilled" && featuresRes.value.ok) {
        const data = await featuresRes.value.json();
        features = data.features as Record<string, boolean>;
      }

      if (!cancelled) {
        setNavItems(getVisibleNavItems(effectiveRole, dbPerms, features));
      }
    }

    loadPermissions();
    return () => {
      cancelled = true;
    };
  }, [effectiveRole]);

  async function startImpersonation(role: string) {
    await fetch("/api/admin/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    globalThis.location.reload();
  }

  // stopImpersonation moved to ImpersonationBanner (rendered globally
  // from _app.tsx so the escape hatch exists on every layout).

  const handleSignOut = async () => {
    await signOut({ redirect: false });
    router.push("/auth/login");
  };

  function isActive(href: string): boolean {
    if (href === "/") return router.pathname === "/";
    return router.pathname === href || router.pathname.startsWith(href + "/");
  }

  return (
    <nav className="w-full border-b border-sh-gray bg-white shadow-sm font-serif">
      {/* Impersonation banner is now global, rendered from _app.tsx via
          <ImpersonationBanner />. That moves the Stop Impersonating
          button to every layout (TopNav, ScannerLayout, MinimalLayout)
          so an ADMIN tester is never locked in. */}

      {/* Top row: logo + sign out */}
      <div className="flex items-center justify-between px-8 h-20">
        <div className="flex items-center gap-4 min-w-[140px]">
          <Link href="/app">
            <BrandLogo
              appName={branding.appName}
              logoUrl={branding.logoUrl}
              width={56}
              height={56}
              className="rounded object-contain"
            />
          </Link>
        </div>

        {/* Center links -- visible on md+ screens */}
        <div className="hidden md:flex items-center justify-center gap-8 text-xl text-sh-black">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`py-2 transition ${
                isActive(item.href)
                  ? "border-b-2 border-sh-gold text-sh-blue font-semibold"
                  : "hover:underline underline-offset-4 hover:text-sh-blue"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className="relative z-10 flex items-center gap-4">
          {/* View As dropdown -- SUPER_ADMIN + ADMIN, not while impersonating */}
          {(realRole === "SUPER_ADMIN" || realRole === "ADMIN") && !isImpersonating && (
            <select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) startImpersonation(e.target.value);
              }}
              className="text-sm border border-sh-gray/40 rounded-lg px-2 py-1.5 bg-white text-sh-gray min-h-[44px]"
            >
              <option value="" disabled>
                View as...
              </option>
              {IMPERSONATE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0) + r.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          )}
          {session && <NotificationBell />}
          {session ? (
            <Button variant="outline" onClick={handleSignOut}>
              Sign Out
            </Button>
          ) : (
            <Link href="/auth/login">
              <Button variant="outline">Sign In</Button>
            </Link>
          )}
        </div>
      </div>

      {/* Bottom row: scrollable nav links on small screens */}
      <div className="flex md:hidden overflow-x-auto scrollbar-hide border-t border-sh-gray/20 px-4 gap-6 text-lg text-sh-black">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`whitespace-nowrap py-3 transition ${
              isActive(item.href)
                ? "border-b-2 border-sh-gold text-sh-blue font-semibold"
                : "hover:text-sh-blue"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
