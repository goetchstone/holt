// /app/src/app/(dashboard)/app/reports/transfers/page.tsx
//
// Transfers: what moved between stores and what is still on its way
// (lib/reports/transfersReport.ts). The server page loads the stores for the
// picker and the store's day, which starts the period; the view reads the report
// over tRPC.

import { prisma } from "@/lib/prisma";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { requirePage } from "@/lib/auth/requirePage";
import { businessDayKey } from "@/lib/reports/businessDay";
import { TransfersReportView } from "./TransfersReportView";

export default async function TransfersReportPage() {
  await requirePage(undefined, { permission: "reporting.read" });
  const [stores, timeZone] = await Promise.all([
    prisma.storeLocation.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getBusinessTimeZone(),
  ]);
  return <TransfersReportView stores={stores} today={businessDayKey(new Date(), timeZone)} />;
}
