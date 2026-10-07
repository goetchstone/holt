// /app/src/app/(dashboard)/app/reports/balance-aging/page.tsx
//
// Balance Due Aging report — App Router + tRPC port. ADMIN only (per-order
// financials). Server component: gates, fetches via the shared lib, hands data
// to the client view. Chrome from the (dashboard) layout.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getBalanceAging } from "@/lib/reports/balanceAging";
import { BalanceAgingView } from "./BalanceAgingView";

export default async function BalanceAgingPage() {
  await requirePage(["ADMIN"]);
  const data = await getBalanceAging(prisma);
  return <BalanceAgingView data={data} />;
}
