// /app/src/app/(dashboard)/app/warehouse/returns/page.tsx
//
// Returns queue (pickup / inspection / decision tabs) -- App Router port.
// MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads the
// shared /api/warehouse/returns/queue + /api/returns/[id]/status REST endpoints,
// which stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ReturnsQueueView } from "./ReturnsQueueView";

export default async function ReturnsQueuePage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <ReturnsQueueView />;
}
