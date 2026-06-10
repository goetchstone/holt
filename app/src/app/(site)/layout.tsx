// /app/src/app/(site)/layout.tsx
//
// Public marketing site layout (no auth). Themed from AppSettings; header and
// footer are driven by the CMS menus. Distinct from the (dashboard) group,
// which carries the authenticated back-office at /app/*.

import type { ReactNode } from "react";
import { getAppSettings } from "@/lib/appSettings";
import { getMenu } from "@/lib/cms/queries";
import { SiteHeader } from "@/components/cms/SiteHeader";
import { SiteFooter } from "@/components/cms/SiteFooter";

// CMS content is per-request (editable without a rebuild), so the public site
// must render dynamically. This also keeps the build from touching the DB while
// prerendering -- the cause of a failed container build on 2026-06-03. Applies
// to all (site) routes via the layout.
export const dynamic = "force-dynamic";

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const [settings, headerMenu, footerMenu] = await Promise.all([
    getAppSettings(),
    getMenu("header"),
    getMenu("footer"),
  ]);

  // themeMode drives the public-site chrome only: "dark" puts the body, header,
  // and footer on the navy/stripe brand tokens (full-dark sites like akritos.com);
  // "light" is the white/linen default. The back-office is unaffected either way.
  const dark = settings.themeMode === "dark";

  return (
    <div
      className={`flex min-h-screen flex-col ${dark ? "bg-sh-navy text-sh-stripe" : "bg-white text-sh-black"}`}
    >
      <SiteHeader
        appName={settings.appName}
        logoUrl={settings.logoUrl}
        items={headerMenu}
        variant={settings.themeMode}
      />
      <main className="flex-1">{children}</main>
      <SiteFooter
        appName={settings.appName}
        items={footerMenu}
        year={new Date().getFullYear()}
        variant={settings.themeMode}
      />
    </div>
  );
}
