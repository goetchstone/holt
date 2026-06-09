// /app/src/app/(dashboard)/app/admin/service/vehicles/page.tsx
//
// Vehicles -- App Router port of the legacy admin/service/vehicles.
// MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads + writes
// the shared /api/dispatch/vehicles REST endpoints. Chrome from the (dashboard)
// layout.

import { requirePage } from "@/lib/auth/requirePage";
import { VehiclesView } from "./VehiclesView";

export default async function VehiclesPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <VehiclesView />;
}
