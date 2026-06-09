// /app/src/app/(dashboard)/app/reports/sales-daily/page.tsx
//
// Daily Sales Report — App Router + tRPC port. The data is filter-driven
// (date range + departments), so unlike the one-shot reports this page gates
// server-side then renders a client view that calls the tRPC hooks reactively.

import { requirePage } from "@/lib/auth/requirePage";
import { SalesDailyView } from "./SalesDailyView";

const REPORT_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER", "MARKETING"];

export default async function SalesDailyPage() {
  await requirePage(REPORT_ROLES);
  return <SalesDailyView />;
}
