// /app/src/app/(dashboard)/app/warehouse/locations/page.tsx
//
// Locations (store locations + stock locations, default receiving location) --
// App Router port. MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth
// roles). Reads the shared /api/warehouse/locations REST endpoint, which stays
// REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { LocationsView } from "./LocationsView";

export default async function LocationsPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <LocationsView />;
}
