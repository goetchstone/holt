// /app/src/app/(dashboard)/app/reports/consignment-report/page.tsx
//
// Consignment Summary — App Router port. ADMIN only, one-shot: the server
// component gates, fetches via the shared lib, and hands the result to the
// client view. Chrome from the (dashboard) layout.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import {
  consignmentSummaryForCaller,
  getConsignmentSummary,
} from "@/lib/reports/consignmentSummary";
import { ConsignmentReportView } from "./ConsignmentReportView";

export default async function ConsignmentReportPage() {
  const { holds } = await requirePage(["ADMIN"], WITH_COST);
  // Values (what is owed and paid to consignors) only for a holder of "View
  // cost"; stripped here, on the server, so they never reach anyone else's
  // browser.
  const data = consignmentSummaryForCaller(
    await getConsignmentSummary(prisma),
    canViewCost({ holds }),
  );
  return <ConsignmentReportView data={data} />;
}
