// /app/src/app/(dashboard)/app/purchasing/orders/page.tsx
//
// Purchase Orders list (also Vendor Returns via ?filter=returns) -- App Router
// port. MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads
// the shared /api/purchasing/orders REST endpoint, which stays REST.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { PurchaseOrdersView } from "./PurchaseOrdersView";

export default async function PurchaseOrdersPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return (
    <Suspense>
      <PurchaseOrdersView />
    </Suspense>
  );
}
