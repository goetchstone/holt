// /app/src/app/(dashboard)/app/warehouse/pickups/page.tsx
//
// Pickup schedule (customer pickups grouped by date) -- App Router port. MANAGER
// / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads the shared
// /api/warehouse/returns/pickups + /api/returns/[id]/status REST endpoints,
// which stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { PickupsView } from "./PickupsView";

export default async function PickupsPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <PickupsView />;
}
