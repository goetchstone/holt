// /app/src/app/(dashboard)/app/admin/service/delivery-zones/page.tsx
//
// Delivery Zones -- App Router port of the legacy admin/service/delivery-zones.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads + writes the shared
// /api/service/delivery-zones REST endpoints. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DeliveryZonesView } from "./DeliveryZonesView";

export default async function DeliveryZonesPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <DeliveryZonesView />;
}
