// /app/src/app/(dashboard)/app/warehouse/awaiting-delivery/page.tsx
//
// Awaiting delivery (ORDER-status orders with no invoice, age + balance + linked
// PO status) -- App Router port. MANAGER / ADMIN / WAREHOUSE (mirrors the legacy
// withAuth roles). Reads the shared /api/warehouse/awaiting-delivery REST
// endpoint, which stays REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { AwaitingDeliveryView } from "./AwaitingDeliveryView";

export default async function AwaitingDeliveryPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <AwaitingDeliveryView />;
}
