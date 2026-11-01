// /app/src/app/(dashboard)/app/reports/on-hold/page.tsx
//
// On hold: every quote line holding floor stock for its customer today,
// soonest to end first (lib/reports/onHold.ts, GAP-16). The server page gates
// and fetches; the view lists them and links the CSV.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getOnHoldReport } from "@/lib/reports/onHold";
import { quoteHoldContext } from "@/lib/sales/quoteHolds";
import { OnHoldView } from "./OnHoldView";

export default async function OnHoldPage() {
  await requirePage(undefined, { permission: "reporting.read" });
  const { today, maxDays } = await quoteHoldContext();
  const rows = await getOnHoldReport(prisma, today);
  return <OnHoldView rows={rows} maxDays={maxDays} />;
}
