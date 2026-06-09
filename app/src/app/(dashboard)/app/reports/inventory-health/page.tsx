// /app/src/app/(dashboard)/app/reports/inventory-health/page.tsx
//
// Inventory Health — on-hand valuation + dead stock by department or vendor.
// MANAGER/ADMIN. Point-in-time snapshot; the client view drives the pivot + stale
// window via tRPC. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { InventoryHealthView } from "./InventoryHealthView";

export default async function InventoryHealthPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <InventoryHealthView />;
}
