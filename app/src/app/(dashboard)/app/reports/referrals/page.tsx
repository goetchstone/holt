// /app/src/app/(dashboard)/app/reports/referrals/page.tsx
//
// Referrals (GAP-08): customers, buyers and spend by how they heard of the
// store, and the customers who sent the most (lib/reports/referrals.ts). The
// server page gates and fetches; the view lays it out.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getReferralReport } from "@/lib/reports/referrals";
import { ReferralsView } from "./ReferralsView";

export default async function ReferralsPage() {
  await requirePage(undefined, { permission: "reporting.read" });
  const report = await getReferralReport(prisma);
  return <ReferralsView report={report} />;
}
