// /app/src/app/(dashboard)/app/warehouse/overview/page.tsx
//
// Warehouse overview (inventory counts by store + stock location) -- App Router
// port. "Transfer stock" (inventory.transfer), the key of its route and of the
// positions page its store links open. Reads the shared
// /api/warehouse/dashboard/summary REST endpoint, which stays REST. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { WarehouseOverviewView } from "./WarehouseOverviewView";

export default async function WarehouseOverviewPage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <WarehouseOverviewView />;
}
