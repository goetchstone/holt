// /app/src/app/(dashboard)/app/admin/automations/daily-reconciliation/page.tsx
//
// Daily Reconciliation -- App Router port of the legacy
// admin/automations/daily-reconciliation. MANAGER / ADMIN (mirrors the legacy
// withAuth roles). "Run reconciliation" POSTs to the shared
// /api/automations/daily-reconciliation REST endpoint, which stays REST. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DailyReconciliationView } from "./DailyReconciliationView";

export default async function DailyReconciliationPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <DailyReconciliationView />;
}
