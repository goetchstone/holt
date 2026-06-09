// /app/src/app/(dashboard)/app/reports/pay-period-sales/page.tsx
//
// Pay Period Sales — App Router + tRPC port. SUPER_ADMIN-only (tabled per owner
// direction 2026-05-29 until management adopts it). Per-designer statement +
// manager confirmation grid; confirm / report-issue / reopen / resolve-issue
// stay REST mutations.

import { requirePage } from "@/lib/auth/requirePage";
import { PayPeriodSalesView } from "./PayPeriodSalesView";

export default async function PayPeriodSalesPage() {
  await requirePage(["SUPER_ADMIN"]);
  return <PayPeriodSalesView />;
}
