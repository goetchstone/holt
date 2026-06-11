// /app/src/app/(dashboard)/app/admin/automations/pos-import/page.tsx
//
// Legacy-POS auto-import status + Run Now. MANAGER / ADMIN. Hidden behind the
// `legacyPosImport` feature flag (editions that don't run a legacy POS in
// parallel never see it). The Run Now POST stays REST so the daily cron and
// this button share one endpoint.

import { requirePage } from "@/lib/auth/requirePage";
import { PosImportView } from "./PosImportView";

export default async function PosImportPage() {
  await requirePage(["MANAGER", "ADMIN"], { feature: "legacyPosImport" });
  return <PosImportView />;
}
