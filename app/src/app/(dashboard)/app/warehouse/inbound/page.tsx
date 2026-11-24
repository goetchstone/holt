// /app/src/app/(dashboard)/app/warehouse/inbound/page.tsx
//
// Inbound POs (open purchase orders by ESD, month/week drill-down with
// vendor/department/type filters) -- App Router port. "Receive stock"
// (purchasing.receive), the key its route is on, so a Buyer can see the POs
// coming in; PO totals stay behind "View cost". Reads the shared
// /api/warehouse/inbound-dashboard REST endpoint, which stays REST. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { InboundDashboardView } from "./InboundDashboardView";

export default async function InboundDashboardPage() {
  await requirePage(undefined, { permission: "purchasing.receive" });
  return <InboundDashboardView />;
}
