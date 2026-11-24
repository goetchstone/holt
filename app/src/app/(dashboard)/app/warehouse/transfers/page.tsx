// /app/src/app/(dashboard)/app/warehouse/transfers/page.tsx
//
// Transfers list (inventory transfers between locations) -- App Router port.
// "Transfer stock" (inventory.transfer), the key of its list route. Reads the
// shared /api/warehouse/transfers REST endpoint, which stays REST. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TransfersView } from "./TransfersView";

export default async function TransferListPage() {
  await requirePage(undefined, { permission: "inventory.transfer" });
  return <TransfersView />;
}
