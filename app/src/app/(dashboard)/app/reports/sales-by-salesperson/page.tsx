// /app/src/app/(dashboard)/app/reports/sales-by-salesperson/page.tsx
//
// Sales by Salesperson — App Router + tRPC port. Gated on "View reports", as
// its tRPC procedures are; cost and margin need "View cost" too (SEC-14). The
// procedures scope non-privileged roles to their own data via
// resolveSalesPersonFilter.
// Filter-driven, so the server page just gates and renders the client view.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { SalesBySalespersonView } from "./SalesBySalespersonView";

export default async function SalesBySalespersonPage() {
  await requirePage(undefined, { permission: "reporting.read" });
  return <SalesBySalespersonView />;
}
