// /app/src/app/(dashboard)/app/warehouse/positions/page.tsx
//
// Inventory by location (positions table with store + stock-location filters) --
// App Router port. MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth
// roles). Reads the shared /api/warehouse/locations + /api/warehouse/positions
// REST endpoints, which stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { InventoryPositionsView } from "./InventoryPositionsView";

export default async function InventoryPositionsPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <InventoryPositionsView />;
}
