// /app/src/app/(dashboard)/app/page.tsx
//
// Root home ("/") -- manager-facing dashboard. App Router port of
// pages/index.tsx. Authed via requirePage; designers are redirected straight to
// Sales (the dashboard is manager-facing), mirroring the legacy getServerSideProps
// role redirect. The (dashboard) layout supplies the nav chrome, so HomeView
// renders content only (no MainLayout).

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { resolvePermissionAccess } from "@/lib/auth/permissionResolver";
import { HomeView } from "./HomeView";
import { isModuleEnabled } from "@/lib/modules/requireModule";

export default async function HomePage() {
  const { role, userId } = await requirePage();
  if (role === "DESIGNER") {
    redirect("/app/sales");
  }
  // Resolved here rather than in the client component: the flags come from
  // AppSettings and the dashboard should not render a section and then hide it.
  // Whether the module is on and whether this viewer may see traffic are kept
  // apart: "switched off for this deployment" must never be what a role
  // without "View store traffic" is told.
  const impersonate = (await cookies()).get("holt-impersonate")?.value ?? null;
  const [trafficModuleOn, showUpBoard, traffic] = await Promise.all([
    isModuleEnabled("storeTraffic"),
    isModuleEnabled("upBoard"),
    resolvePermissionAccess({ userId, permission: "reporting.traffic", impersonate }),
  ]);
  return (
    <HomeView
      trafficModuleOn={trafficModuleOn}
      canSeeTraffic={traffic.allowed}
      showUpBoard={showUpBoard}
    />
  );
}
