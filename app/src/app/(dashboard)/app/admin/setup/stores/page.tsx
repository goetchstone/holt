// /app/src/app/(dashboard)/app/admin/setup/stores/page.tsx
//
// Store Locations -- App Router port of the legacy admin/setup/stores.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/warehouse/locations REST endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { StoresView } from "./StoresView";

export default async function StoreLocationsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <StoresView />;
}
