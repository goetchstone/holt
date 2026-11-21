// /app/src/app/(dashboard)/app/reports/designer-dashboard/page.tsx
//
// Designer Dashboard — App Router + tRPC port. Gated on "View reports", as its
// tRPC procedure is; the average margin needs "View cost" too (SEC-14). Whether
// the viewer may pick any salesperson ("See every salesperson's numbers") is
// answered here, from the same staff read as the gate, and handed to the view
// for its picker; the procedure makes the same decision and scopes everyone else
// to their own record. Filter-driven, so the server page just gates and renders
// the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { canSeeAllSalespeople, WITH_ALL_SALESPEOPLE } from "@/lib/reports/salespersonScope";
import { DesignerDashboardView } from "./DesignerDashboardView";

export default async function DesignerDashboardPage() {
  const access = await requirePage(undefined, {
    permission: "reporting.read",
    ...WITH_ALL_SALESPEOPLE,
  });
  return <DesignerDashboardView canSeeAllSalespeople={canSeeAllSalespeople(access)} />;
}
