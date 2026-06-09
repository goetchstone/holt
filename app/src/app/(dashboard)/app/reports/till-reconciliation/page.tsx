// /app/src/app/(dashboard)/app/reports/till-reconciliation/page.tsx
//
// Till Reconciliation — App Router port. Any signed-in user (matches the legacy
// session-only gate). Reads shared /api/tills + /api/warehouse/locations REST
// endpoints (used outside the reports domain).

import { requirePage } from "@/lib/auth/requirePage";
import { TillReconciliationView } from "./TillReconciliationView";

export default async function TillReconciliationPage() {
  await requirePage();
  return <TillReconciliationView />;
}
