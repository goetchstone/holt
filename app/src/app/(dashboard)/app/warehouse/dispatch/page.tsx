// /app/src/app/(dashboard)/app/warehouse/dispatch/page.tsx
//
// Dispatch queue (pending + ready orders with status progression) -- App Router
// port. MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads
// the shared /api/warehouse/dispatch/* + /api/sales/orders REST endpoints, which
// stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DispatchQueueView } from "./DispatchQueueView";

export default async function DispatchQueuePage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <DispatchQueueView />;
}
