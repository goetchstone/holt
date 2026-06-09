// /app/src/app/(dashboard)/app/admin/export/windfall/page.tsx
//
// Windfall data export -- App Router page-only port of the legacy
// admin/export/windfall. MANAGER / ADMIN (mirrors the legacy withAuth roles).
// Downloads prior-week sales + full customer CSVs from the shared
// /api/exports/windfall-* REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { WindfallExportView } from "./WindfallExportView";

export default async function WindfallExportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <WindfallExportView />;
}
