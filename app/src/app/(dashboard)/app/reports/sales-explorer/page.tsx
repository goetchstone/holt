// /app/src/app/(dashboard)/app/reports/sales-explorer/page.tsx
//
// Sales Explorer — two-period comparative sales pivoted by Store / Department
// / Category / Vendor, with drill-down to product-level rows. Filter-driven
// (data fetches via tRPC on "Run Report"), so this server page just gates and
// renders the client view. Chrome from the (dashboard) layout. The same gate
// as Comparative Sales / Gross Margin: "View management reports".

import { requirePage } from "@/lib/auth/requirePage";
import { SalesExplorerView } from "./SalesExplorerView";

export default async function SalesExplorerPage() {
  await requirePage(undefined, { permission: "reporting.management" });
  return <SalesExplorerView />;
}
