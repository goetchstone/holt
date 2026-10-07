// /app/src/app/(dashboard)/app/reports/open-orders/page.tsx
//
// Open Orders report — first Phase-M port (Pages Router → App Router). Server
// component: gates on "View reports" (and answers "View cost"), fetches the report via the shared lib
// (no HTTP round-trip), and hands the data to the client view. Chrome (nav +
// max-width main + footer) comes from the (dashboard) layout.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getOpenOrdersReport, openOrdersForCaller } from "@/lib/reports/openOrders";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { OpenOrdersView } from "./OpenOrdersView";

export default async function OpenOrdersPage() {
  const { holds } = await requirePage(undefined, { permission: "reporting.read", ...WITH_COST });
  // PO values only for a holder of "View cost"; stripped here, on the server,
  // so they never reach the browser of anyone else.
  const data = openOrdersForCaller(await getOpenOrdersReport(prisma), canViewCost({ holds }));
  return <OpenOrdersView data={data} />;
}
