// /app/src/app/(dashboard)/app/inventory/consignment/po-management/page.tsx
//
// Consignment PO Management — App Router port of the legacy
// inventory/consignment/po-management, where consignor payouts are prepared.
// On "View accounting", like Payments and Credits Owed, which link here. Reads
// + mutates the shared /api/consignment/po-management/* + /api/consignment/*
// REST endpoints, which stay REST and are on "Write purchase orders"; every
// built-in role with View accounting holds that too.

import { requirePage } from "@/lib/auth/requirePage";
import { POManagementView } from "./POManagementView";

export default async function POManagementPage() {
  await requirePage(undefined, { permission: "accounting.read" });
  return <POManagementView />;
}
