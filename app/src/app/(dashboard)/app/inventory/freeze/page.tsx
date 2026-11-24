// /app/src/app/(dashboard)/app/inventory/freeze/page.tsx
//
// Inventory Freeze — App Router port of the legacy inventory/freeze. On "Run
// counts", the key of its Compare route and of the count screens beside it on
// the Physical Inventory Hub. Creating and cancelling a snapshot stay on
// "Adjust inventory" in their routes. Reads the shared /api/inventory/freeze*
// REST endpoints, which stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { FreezeView } from "./FreezeView";

export default async function InventoryFreezePage() {
  await requirePage(undefined, { permission: "inventory.count" });
  return <FreezeView />;
}
