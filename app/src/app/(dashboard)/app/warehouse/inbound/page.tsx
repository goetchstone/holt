// /app/src/app/(dashboard)/app/warehouse/inbound/page.tsx
//
// Inbound POs (open purchase orders by ESD, month/week drill-down with
// vendor/department/type filters) -- App Router port. MANAGER / ADMIN /
// WAREHOUSE (mirrors the legacy withAuth roles). Reads the shared
// /api/warehouse/inbound-dashboard REST endpoint, which stays REST. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { InboundDashboardView } from "./InboundDashboardView";

export default async function InboundDashboardPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <InboundDashboardView />;
}
