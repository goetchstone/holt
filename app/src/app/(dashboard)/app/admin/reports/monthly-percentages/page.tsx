// /app/src/app/(dashboard)/app/admin/reports/monthly-percentages/page.tsx
//
// Monthly sales percentages -- App Router page-only port of the legacy
// admin/reports/monthly-percentages. Change settings (admin.settings), the key
// its API /api/reports/monthly-percentages also takes. Reads + writes that
// shared REST endpoint, which stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { MonthlyPercentagesView } from "./MonthlyPercentagesView";

export default async function MonthlyPercentagesPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  return <MonthlyPercentagesView />;
}
