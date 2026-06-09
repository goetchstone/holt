// /app/src/app/(dashboard)/app/reports/weekly-summary/page.tsx
//
// Weekly Sales Summary — App Router port. Any signed-in user (matches the legacy
// session-only gate). Reads the shared /api/dashboard/weekly REST endpoint
// (tRPC move tracked as a follow-up).

import { requirePage } from "@/lib/auth/requirePage";
import { WeeklySummaryView } from "./WeeklySummaryView";

export default async function WeeklySummaryPage() {
  await requirePage();
  return <WeeklySummaryView />;
}
