// /app/src/app/(dashboard)/app/warehouse/dashboard/page.tsx
//
// Warehouse dashboard (summary cards + inventory-by-location + inbound POs) --
// App Router port. "Transfer stock" (inventory.transfer), the key of its
// summary route; its inbound route is on "Receive stock" (purchasing.receive),
// which every default holder of Transfer stock also holds. Reads the shared
// /api/warehouse/dashboard/* REST endpoints, which stay REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { WarehouseDashboardView } from "./WarehouseDashboardView";

export default async function WarehouseDashboardPage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <WarehouseDashboardView />;
}
