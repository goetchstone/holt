// /app/src/app/(dashboard)/app/purchasing/orders/page.tsx
//
// Purchase Orders list (also Vendor Returns via ?filter=returns) -- App Router
// port. "View purchasing", the key its list route is on; a holder of "Write
// purchase orders" also gets New purchase order (GAP-01). Reads the shared
// /api/purchasing/orders REST endpoint, which stays REST.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { PurchaseOrdersView } from "./PurchaseOrdersView";

export default async function PurchaseOrdersPage() {
  const { holds } = await requirePage(undefined, {
    permission: "purchasing.read",
    also: ["purchasing.write"],
  });
  return (
    <Suspense>
      <PurchaseOrdersView canWrite={holds["purchasing.write"]} />
    </Suspense>
  );
}
