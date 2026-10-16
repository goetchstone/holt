// /app/src/app/(dashboard)/app/reports/oversold/page.tsx
//
// Oversold: what was sold without the stock to cover it, by product, and the
// most direct way to cover each gap (lib/reports/oversold.ts). Rows close
// themselves once the order holds what it needs. The server page gates and
// fetches; the view filters by store and links the CSV.

import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth/requirePage";
import { getOversoldReport } from "@/lib/reports/oversold";
import { OversoldView } from "./OversoldView";

export default async function OversoldPage() {
  await requirePage(undefined, { permission: "reporting.read" });
  const rows = await getOversoldReport(prisma);
  return <OversoldView rows={JSON.parse(JSON.stringify(rows))} />;
}
