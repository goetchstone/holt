// /app/src/app/(dashboard)/app/dispatch/planner/page.tsx
//
// Delivery planner (inbound POs grouped by ESD week within zones, with pencil-in
// scheduling) -- App Router port. MANAGER / ADMIN / WAREHOUSE (mirrors the legacy
// withAuth roles). Reads the shared /api/dispatch/* REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { DeliveryPlannerView } from "./DeliveryPlannerView";

export default async function DeliveryPlannerPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <DeliveryPlannerView />;
}
