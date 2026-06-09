// /app/src/app/(dashboard)/app/reports/open-orders/page.tsx
//
// Open Orders report — first Phase-M port (Pages Router → App Router). Server
// component: gates on the Reports roles, fetches the report via the shared lib
// (no HTTP round-trip), and hands the data to the client view. Chrome (nav +
// max-width main + footer) comes from the (dashboard) layout.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getOpenOrdersReport } from "@/lib/reports/openOrders";
import { OpenOrdersView } from "./OpenOrdersView";

const REPORT_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER", "MARKETING"];

export default async function OpenOrdersPage() {
  await requirePage(REPORT_ROLES);
  const data = await getOpenOrdersReport(prisma);
  return <OpenOrdersView data={data} />;
}
