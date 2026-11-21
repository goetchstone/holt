// /app/src/app/(dashboard)/app/purchasing/needs-ordering/page.tsx
//
// Needs Ordering -- App Router port. On "Receive stock", the key its data route
// (/api/purchasing/needs-ordering) is on, as the PO list, detail and Receive
// pages take their routes' keys. Its Create PO posts to
// /api/sales/orders/[id]/create-po, which is "Write orders", so a holder
// without that (a Buyer, the warehouse) sees the queue but cannot raise the PO
// from it. Both endpoints stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { NeedsOrderingView } from "./NeedsOrderingView";

export default async function NeedsOrderingPage() {
  await requirePage(undefined, { permission: "purchasing.receive" });
  return <NeedsOrderingView />;
}
