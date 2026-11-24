// /app/src/app/(dashboard)/app/reports/balance-aging/page.tsx
//
// Balance Due Aging report — App Router + tRPC port. "View financial reports"
// (per-order financials; an ADMIN-only role list until the 2026-11 sweep).
// Server component: gates, fetches via the shared lib, hands data to the client
// view. Chrome from the (dashboard) layout.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getBalanceAging } from "@/lib/reports/balanceAging";
import { BalanceAgingView } from "./BalanceAgingView";

export default async function BalanceAgingPage() {
  await requirePage(undefined, { permission: "reporting.financial" });
  const data = await getBalanceAging(prisma);
  return <BalanceAgingView data={data} />;
}
