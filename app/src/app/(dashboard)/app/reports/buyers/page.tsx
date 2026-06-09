// /app/src/app/(dashboard)/app/reports/buyers/page.tsx
//
// Buyers Report — App Router + tRPC port. MANAGER/ADMIN (mirrors the legacy
// withAuth gate). Filter-driven (date range + pivot + frame rollup) with a
// 5-level drilldown and an on-demand per-product location expansion, so this
// server page just gates and renders the client view. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { BuyersReportView } from "./BuyersReportView";

export default async function BuyersReportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <BuyersReportView />;
}
