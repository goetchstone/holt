// /app/src/app/(dashboard)/app/warehouse/locations/page.tsx
//
// Locations (store locations + stock locations, default receiving location) --
// App Router port. "Transfer stock" (inventory.transfer): of the three keys its
// list route reads on, the one warehouse staff hold, so they can view it.
// Saving needs "Set up stores and stock locations" or "Manage configuration",
// which the routes enforce. Reads the shared /api/warehouse/locations REST
// endpoint, which stays REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { LocationsView } from "./LocationsView";

export default async function LocationsPage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <LocationsView />;
}
