// /app/src/app/(dashboard)/app/reports/sales-by-salesperson/page.tsx
//
// Sales by Salesperson — App Router + tRPC port. Gated on "View reports", as
// its tRPC procedures are; cost and margin need "View cost" too (SEC-14).
// Whether the viewer may see every salesperson ("See every salesperson's
// numbers" or "See customer lists", salesBySalespersonSeesEveryone) is answered
// here, from the same staff read as the gate, and handed to the view for its
// picker. The procedures and the CSV export make the same decision and lock
// everyone else to their own data (resolveSalesPersonFilter).
// Filter-driven, so the server page just gates and renders the client view.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import {
  salesBySalespersonSeesEveryone,
  WITH_SALES_BY_SALESPERSON_EVERYONE,
} from "@/lib/reports/salespersonScope";
import { SalesBySalespersonView } from "./SalesBySalespersonView";

export default async function SalesBySalespersonPage() {
  const access = await requirePage(undefined, {
    permission: "reporting.read",
    ...WITH_SALES_BY_SALESPERSON_EVERYONE,
  });
  return <SalesBySalespersonView canSeeAllSalespeople={salesBySalespersonSeesEveryone(access)} />;
}
