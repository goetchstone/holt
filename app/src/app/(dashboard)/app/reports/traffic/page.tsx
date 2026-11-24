// /app/src/app/(dashboard)/app/reports/traffic/page.tsx
//
// Store Traffic — App Router + tRPC port. "View management reports". Filter-driven
// (date range + store filter fetch via tRPC; CSV export stays a REST download
// route), so this server page just gates and renders the client view.

import { requirePage } from "@/lib/auth/requirePage";
import { TrafficReportView } from "./TrafficReportView";

export default async function TrafficReportPage() {
  await requirePage(undefined, { permission: "reporting.management" });
  return <TrafficReportView />;
}
