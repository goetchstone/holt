// /app/src/app/(dashboard)/app/admin/export/data/page.tsx
//
// Data export -- App Router page-only port of the legacy admin/export/data. The
// anti-lock-in promise: an operator owns their data and can pull it out any time,
// no support ticket. Date-range General Journal export for the accountant /
// QuickBooks handoff, plus one-click CSV per core business entity. ADMIN only
// (mirrors the legacy withAuth roles). Reads the shared /api/admin/export/* and
// /api/accounting/export-journal REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ExportDataView } from "./ExportDataView";

export default async function ExportDataPage() {
  await requirePage(["ADMIN"]);
  return <ExportDataView />;
}
