// /app/src/app/(dashboard)/app/dispatch/planner/page.tsx
//
// Delivery planner (inbound POs grouped by ESD week within zones, with pencil-in
// scheduling) -- App Router port. "Operate warehouse" (warehouse.operate), the
// key of its planner and pencil-in routes and the rest of dispatch. Reads the
// shared /api/dispatch/* REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { DeliveryPlannerView } from "./DeliveryPlannerView";

export default async function DeliveryPlannerPage() {
  await requirePage(undefined, { permission: "warehouse.operate" });
  return <DeliveryPlannerView />;
}
