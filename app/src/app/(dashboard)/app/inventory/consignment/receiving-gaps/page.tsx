// /app/src/app/(dashboard)/app/inventory/consignment/receiving-gaps/page.tsx
//
// Consignment Receiving Gaps — App Router port of the legacy
// inventory/consignment/receiving-gaps. On "View accounting", the key of
// Reconciliation (the only screen that links here) and of the gaps list this
// page reads. Its Link to Receipt posts to a route on "Write purchase orders"
// and its Assign Location to one on "Adjust inventory"; every built-in role
// with View accounting holds both. Reads + mutates the shared /api/consignment/*
// + /api/store-locations + /api/vendors REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ReceivingGapsView } from "./ReceivingGapsView";

export default async function ReceivingGapsPage() {
  await requirePage(undefined, { permission: "accounting.read" });
  return <ReceivingGapsView />;
}
