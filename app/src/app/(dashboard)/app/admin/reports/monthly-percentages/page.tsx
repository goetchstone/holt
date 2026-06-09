// /app/src/app/(dashboard)/app/admin/reports/monthly-percentages/page.tsx
//
// Monthly sales percentages -- App Router page-only port of the legacy
// admin/reports/monthly-percentages. MANAGER / ADMIN (mirrors the legacy
// withAuth roles). Reads + writes the shared /api/reports/monthly-percentages
// REST endpoint, which stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { MonthlyPercentagesView } from "./MonthlyPercentagesView";

export default async function MonthlyPercentagesPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <MonthlyPercentagesView />;
}
