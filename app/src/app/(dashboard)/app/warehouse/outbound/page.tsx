// /app/src/app/(dashboard)/app/warehouse/outbound/page.tsx
//
// Outbound dashboard (scheduled deliveries, needs-scheduling, stock transfers)
// -- App Router port. "Transfer stock" (inventory.transfer), the key its route
// is on. Reads the shared /api/warehouse/outbound-dashboard REST endpoint,
// which stays REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { OutboundDashboardView } from "./OutboundDashboardView";

export default async function OutboundDashboardPage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <OutboundDashboardView />;
}
