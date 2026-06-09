// /app/src/app/(dashboard)/app/inventory/consignment/receiving-gaps/page.tsx
//
// Consignment Receiving Gaps — App Router port of the legacy
// inventory/consignment/receiving-gaps. MANAGER + ADMIN only (mirrors the legacy
// withAuth(undefined, { roles: ["MANAGER", "ADMIN"] })). Reads + mutates the
// shared /api/consignment/* + /api/warehouse/locations + /api/vendors REST
// endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ReceivingGapsView } from "./ReceivingGapsView";

export default async function ReceivingGapsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <ReceivingGapsView />;
}
