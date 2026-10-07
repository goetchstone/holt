// /app/src/app/(dashboard)/app/page.tsx
//
// Root home ("/") -- the signed-in landing page. App Router port of
// pages/index.tsx. Every staff member lands here (owner decision Q5,
// 2026-09-24); what it shows follows the viewer's keys (lib/homeSections.ts),
// never a role name. The (dashboard) layout supplies the nav chrome, so
// HomeView renders content only (no MainLayout).

import { cookies } from "next/headers";
import { requirePage } from "@/lib/auth/requirePage";
import { resolvePermissionAccess } from "@/lib/auth/permissionResolver";
import { homeSections } from "@/lib/homeSections";
import { HomeView } from "./HomeView";
import { isModuleEnabled } from "@/lib/modules/requireModule";

export default async function HomePage() {
  const { userId } = await requirePage();
  // Resolved here rather than in the client component: the flags come from
  // AppSettings and the keys from the database, and the page should not render
  // a section and then hide it.
  const impersonate = (await cookies()).get("holt-impersonate")?.value ?? null;
  const [trafficModuleOn, upBoardOn, traffic, sales] = await Promise.all([
    isModuleEnabled("storeTraffic"),
    isModuleEnabled("upBoard"),
    resolvePermissionAccess({ userId, permission: "reporting.traffic", impersonate }),
    resolvePermissionAccess({ userId, permission: "sales.read", impersonate }),
  ]);
  return (
    <HomeView
      sections={homeSections({
        trafficModuleOn,
        upBoardOn,
        canSeeTraffic: traffic.allowed,
        canSeeSales: sales.allowed,
      })}
    />
  );
}
