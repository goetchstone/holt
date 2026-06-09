// /app/src/app/(dashboard)/app/admin/import/service-cases/page.tsx
//
// Import Customer Service Sheet -- App Router port of the legacy
// admin/import/service-cases. ADMIN / SUPER_ADMIN (mirrors the legacy withAuth
// roles). Reads the shared /api/admin/service/import-sheet REST endpoint, which
// stays REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ServiceCasesImportView } from "./ServiceCasesImportView";

export default async function ImportServiceCasesPage() {
  await requirePage(["ADMIN", "SUPER_ADMIN"]);
  return <ServiceCasesImportView />;
}
