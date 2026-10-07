// /app/src/app/(dashboard)/app/inventory/freeze/page.tsx
//
// Inventory Freeze — App Router port of the legacy inventory/freeze. Restricted
// to MANAGER/ADMIN/WAREHOUSE (matches the legacy withAuth roles). Reads the
// shared /api/inventory/freeze* REST endpoints, which stay REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { FreezeView } from "./FreezeView";

export default async function InventoryFreezePage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <FreezeView />;
}
