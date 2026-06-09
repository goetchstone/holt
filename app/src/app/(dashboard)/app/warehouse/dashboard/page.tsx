// /app/src/app/(dashboard)/app/warehouse/dashboard/page.tsx
//
// Warehouse dashboard (summary cards + inventory-by-location + inbound POs) --
// App Router port. MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth
// roles). Reads the shared /api/warehouse/dashboard/* REST endpoints, which
// stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { WarehouseDashboardView } from "./WarehouseDashboardView";

export default async function WarehouseDashboardPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <WarehouseDashboardView />;
}
