// /app/src/app/(dashboard)/app/reports/factsalesday/page.tsx
//
// Daily Sales Summary report — App Router + tRPC port. Server component: gates
// on Reports roles, fetches via the shared lib, hands rows to the client view.
// Chrome comes from the (dashboard) layout.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getFactSalesDay } from "@/lib/reports/factSalesDay";
import { FactSalesDayView } from "./FactSalesDayView";

const REPORT_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER", "MARKETING"];

export default async function FactSalesDayPage() {
  await requirePage(REPORT_ROLES);
  const rows = await getFactSalesDay(prisma);
  return <FactSalesDayView rows={rows} />;
}
