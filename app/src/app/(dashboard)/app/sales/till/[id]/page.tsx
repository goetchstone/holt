// /app/src/app/(dashboard)/app/sales/till/[id]/page.tsx
//
// Till detail (staff/timing, financials, denomination counts, payments,
// reconcile) -- App Router port of the legacy sales/till/[id]. Opens on "View
// orders" (sales.read), which covers the till screens; the reconcile action is
// offered to holders of "Adjust till counts" (pos.till.adjust), the key the
// reconcile route requires. Reads + writes the shared /api/tills/:id REST
// endpoints, which stay REST. In Next 16 `params` is a Promise, so it must be
// awaited before reading id. Nested under the /sales/till list -- distinct
// path, no collision.

import { requirePage } from "@/lib/auth/requirePage";
import { TillDetailView } from "./TillDetailView";

export default async function TillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { holds } = await requirePage(undefined, {
    permission: "sales.read",
    also: ["pos.till.adjust"],
  });
  return <TillDetailView id={id} canReconcile={holds["pos.till.adjust"]} />;
}
