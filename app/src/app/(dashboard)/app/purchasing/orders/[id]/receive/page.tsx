// /app/src/app/(dashboard)/app/purchasing/orders/[id]/receive/page.tsx
//
// Receive Shipment (scanner-optimized receiving flow) -- App Router port.
// MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads the
// shared /api/purchasing/orders/[id] (GET + receive POST) + /api/warehouse/locations
// + /api/print-label/batch REST endpoints, which stay REST. In Next 16 `params`
// is a Promise, so it must be awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { ReceivePOView } from "./ReceivePOView";

export default async function ReceivePOPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <ReceivePOView id={id} />;
}
