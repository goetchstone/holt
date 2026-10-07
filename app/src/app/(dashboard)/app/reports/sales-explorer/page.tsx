// /app/src/app/(dashboard)/app/reports/sales-explorer/page.tsx
//
// Sales Explorer — two-period comparative sales pivoted by Store / Department
// / Category / Vendor, with drill-down to product-level rows. Filter-driven
// (data fetches via tRPC on "Run Report"), so this server page just gates and
// renders the client view. Chrome from the (dashboard) layout. Same
// MANAGER/ADMIN gate as Comparative Sales / Gross Margin (SUPER_ADMIN is
// auto-granted by requirePage/decideRoleAccess — see lib/auth/roleDecision.ts
// — but listed explicitly here to match Service KPIs / Store Traffic).

import { requirePage } from "@/lib/auth/requirePage";
import { SalesExplorerView } from "./SalesExplorerView";

export default async function SalesExplorerPage() {
  await requirePage(["SUPER_ADMIN", "ADMIN", "MANAGER"]);
  return <SalesExplorerView />;
}
