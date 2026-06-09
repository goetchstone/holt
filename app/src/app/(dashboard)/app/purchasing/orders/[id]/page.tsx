// /app/src/app/(dashboard)/app/purchasing/orders/[id]/page.tsx
//
// Purchase Order detail (summary, acknowledgement, line items, receiving
// records, status transitions) -- App Router port. MANAGER / ADMIN / WAREHOUSE
// (mirrors the legacy withAuth roles). Reads the shared /api/purchasing/orders/[id]
// REST endpoint, which stays REST. In Next 16 `params` is a Promise, so it must
// be awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { PurchaseOrderDetailView } from "./PurchaseOrderDetailView";

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <PurchaseOrderDetailView id={id} />;
}
