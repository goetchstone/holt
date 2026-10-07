// /app/src/app/(dashboard)/app/warehouse/outbound/page.tsx
//
// Outbound dashboard (scheduled deliveries, needs-scheduling, stock transfers)
// -- App Router port. MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth
// roles). Reads the shared /api/warehouse/outbound-dashboard REST endpoint,
// which stays REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { OutboundDashboardView } from "./OutboundDashboardView";

export default async function OutboundDashboardPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <OutboundDashboardView />;
}
