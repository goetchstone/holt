// /app/src/app/(dashboard)/app/admin/sales/salesperson-corrections/page.tsx
//
// Salesperson corrections -- App Router page-only port of the legacy
// admin/sales/salesperson-corrections. MANAGER / ADMIN (mirrors the legacy
// withAuth roles). Reads /api/sales/orders + /api/staff and bulk-reassigns via
// /api/admin/sales/bulk-update-salesperson, all of which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { SalespersonCorrectionsView } from "./SalespersonCorrectionsView";

export default async function SalespersonCorrectionsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <SalespersonCorrectionsView />;
}
