// /app/src/app/(dashboard)/app/warehouse/dispatch/page.tsx
//
// Dispatch queue (pending + ready orders with status progression) -- App Router
// port. "Operate warehouse" (warehouse.operate), the key of its pending and
// ready routes and the rest of dispatch. Reads the shared
// /api/warehouse/dispatch/* + /api/sales/orders REST endpoints, which stay REST.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DispatchQueueView } from "./DispatchQueueView";

export default async function DispatchQueuePage() {
  await requirePage(undefined, { permission: "warehouse.operate" });
  return <DispatchQueueView />;
}
