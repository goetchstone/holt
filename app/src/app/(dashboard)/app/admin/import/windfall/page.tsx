// /app/src/app/(dashboard)/app/admin/import/windfall/page.tsx
//
// Windfall Enrichment Import -- App Router port of the legacy
// admin/import/windfall. ADMIN only (mirrors the legacy withAuth roles). Reads
// the shared /api/customers/windfall-import REST endpoint, which stays REST.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { WindfallImportView } from "./WindfallImportView";

export default async function WindfallImportPage() {
  await requirePage(["ADMIN"]);
  return <WindfallImportView />;
}
