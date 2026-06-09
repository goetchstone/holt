// /app/src/app/(dashboard)/app/reports/dashboard/page.tsx
//
// Weekly Sales Dashboard — App Router port. Any signed-in user (matches the
// legacy session-only gate). Reads shared /api/dashboard/weekly + /api/departments
// REST endpoints; a tRPC move for those shared endpoints is a separate follow-up.

import { requirePage } from "@/lib/auth/requirePage";
import { DashboardView } from "./DashboardView";

export default async function DashboardReportPage() {
  await requirePage();
  return <DashboardView />;
}
