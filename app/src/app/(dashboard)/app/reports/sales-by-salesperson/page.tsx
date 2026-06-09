// /app/src/app/(dashboard)/app/reports/sales-by-salesperson/page.tsx
//
// Sales by Salesperson — App Router + tRPC port. Visible to any signed-in user
// (matches the legacy session-only gate); the tRPC procedures scope
// non-privileged roles to their own data via resolveSalesPersonFilter.
// Filter-driven, so the server page just gates and renders the client view.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { SalesBySalespersonView } from "./SalesBySalespersonView";

export default async function SalesBySalespersonPage() {
  await requirePage();
  return <SalesBySalespersonView />;
}
