// /app/src/app/(dashboard)/app/inventory/consignment/reconciliation/page.tsx
//
// Consignment Reconciliation — App Router port of the legacy
// inventory/consignment/reconciliation. Any signed-in user (mirrors the legacy
// bare withAuth(), no roles/feature). Reads the shared /api/consignment/stats +
// /api/consignment/items REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ReconciliationView } from "./ReconciliationView";

export default async function ReconciliationPage() {
  await requirePage();
  return <ReconciliationView />;
}
