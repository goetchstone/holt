// /app/src/app/(dashboard)/app/warehouse/awaiting-delivery/page.tsx
//
// Awaiting delivery (ORDER-status orders with no invoice, age + balance + linked
// PO status) -- App Router port. "Transfer stock" (inventory.transfer), the key
// of its sibling Outbound and the other warehouse dashboards. Its route is on
// "Receive stock" (purchasing.receive), which every default holder of Transfer
// stock also holds; the page does not take that key, because it would add
// Buyers to a screen of customers' balances. Reads the shared
// /api/warehouse/awaiting-delivery REST endpoint, which stays REST. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { AwaitingDeliveryView } from "./AwaitingDeliveryView";

export default async function AwaitingDeliveryPage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <AwaitingDeliveryView />;
}
