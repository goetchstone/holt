// /app/src/app/(dashboard)/app/purchasing/orders/[id]/page.tsx
//
// Purchase Order detail (summary, acknowledgement, line items, receiving
// records, status transitions, print and email) -- App Router port. "View
// purchasing", the key its route's GET is on; a holder of "Write purchase
// orders" also gets Edit, Duplicate and Email (GAP-01) and landed charges, and
// one of "Adjust inventory" may take a receipt back (GAP-02). Reads the shared
// /api/purchasing/orders/[id] REST endpoint, which stays REST. In Next 16
// `params` is a Promise, so it must be awaited before reading id.

import { requirePage } from "@/lib/auth/requirePage";
import { PurchaseOrderDetailView } from "./PurchaseOrderDetailView";

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { holds } = await requirePage(undefined, {
    permission: "purchasing.read",
    also: ["purchasing.write", "inventory.adjust"],
  });
  return (
    <PurchaseOrderDetailView
      id={id}
      canWrite={holds["purchasing.write"]}
      canAdjust={holds["inventory.adjust"]}
    />
  );
}
