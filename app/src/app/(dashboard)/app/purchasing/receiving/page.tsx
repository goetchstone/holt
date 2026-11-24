// /app/src/app/(dashboard)/app/purchasing/receiving/page.tsx
//
// Receiving Records list -- App Router port. On "Receive stock", the key its
// data route (/api/purchasing/receiving) is on, like the Receive page; PO cost
// only for a holder of "View cost". Reads that shared REST endpoint, which
// stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ReceivingListView } from "./ReceivingListView";

export default async function ReceivingListPage() {
  await requirePage(undefined, { permission: "purchasing.receive" });
  return <ReceivingListView />;
}
