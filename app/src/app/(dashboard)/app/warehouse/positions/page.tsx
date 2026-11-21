// /app/src/app/(dashboard)/app/warehouse/positions/page.tsx
//
// Inventory by location (positions table with store + stock-location filters) --
// App Router port. "Transfer stock" (inventory.transfer), the key of its
// positions route. Reads the shared /api/store-locations/stock-locations +
// /api/warehouse/positions REST endpoints, which stay REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { InventoryPositionsView } from "./InventoryPositionsView";

export default async function InventoryPositionsPage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <InventoryPositionsView />;
}
