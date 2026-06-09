// /app/src/app/(dashboard)/app/reports/consignment-report/page.tsx
//
// Consignment Summary — App Router port. ADMIN only, one-shot: the server
// component gates, fetches via the shared lib, and hands the result to the
// client view. Chrome from the (dashboard) layout.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getConsignmentSummary } from "@/lib/reports/consignmentSummary";
import { ConsignmentReportView } from "./ConsignmentReportView";

export default async function ConsignmentReportPage() {
  await requirePage(["ADMIN"]);
  const data = await getConsignmentSummary(prisma);
  return <ConsignmentReportView data={data} />;
}
