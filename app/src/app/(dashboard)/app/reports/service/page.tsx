// /app/src/app/(dashboard)/app/reports/service/page.tsx
//
// Service KPIs — App Router + tRPC port. MANAGER/ADMIN/SUPER_ADMIN. Filter-driven
// (goal-days slider fetches via tRPC), so this server page just gates and renders
// the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ServiceReportView } from "./ServiceReportView";

export default async function ServiceReportPage() {
  await requirePage(["MANAGER", "ADMIN", "SUPER_ADMIN"]);
  return <ServiceReportView />;
}
