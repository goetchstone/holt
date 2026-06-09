// /app/src/app/(dashboard)/app/admin/import/consignment/page.tsx
//
// Consignment Import -- App Router page-only port. MANAGER / ADMIN (mirrors the
// legacy withAuth roles). Reads + writes the shared /api/consignment/import/* and
// /api/consignment/bulk-reset-missing REST endpoints, which stay REST. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ConsignmentImportView } from "./ConsignmentImportView";

export default async function ConsignmentImportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <ConsignmentImportView />;
}
