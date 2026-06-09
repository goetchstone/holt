// /app/src/app/(dashboard)/app/inventory/consignment/receive/page.tsx
//
// Receive Consignment Shipment — App Router port of the legacy
// inventory/consignment/receive. Any signed-in user (mirrors the legacy bare
// withAuth(), no roles/feature). Reads /api/warehouse/locations and posts to
// /api/consignment/import/manifest — both stay REST. The manifest XLSX is parsed
// client-side, exactly as in the legacy page.

import { requirePage } from "@/lib/auth/requirePage";
import { ReceiveView } from "./ReceiveView";

export default async function ReceiveShipmentPage() {
  await requirePage();
  return <ReceiveView />;
}
