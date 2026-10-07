// /app/src/app/(dashboard)/app/inventory/consignment/po-management/page.tsx
//
// Consignment PO Management — App Router port of the legacy
// inventory/consignment/po-management. MANAGER + ADMIN only (mirrors the legacy
// withAuth(undefined, { roles: ["MANAGER", "ADMIN"] })). Reads + mutates the
// shared /api/consignment/po-management/* + /api/consignment/* REST endpoints,
// which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { POManagementView } from "./POManagementView";

export default async function POManagementPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <POManagementView />;
}
