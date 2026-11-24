// /app/src/app/(dashboard)/app/reports/returns/page.tsx
//
// Returns Analysis — return rate by department/vendor + most-returned products.
// "View management reports", filter-driven via tRPC. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ReturnsView } from "./ReturnsView";

export default async function ReturnsPage() {
  await requirePage(undefined, { permission: "reporting.management" });
  return <ReturnsView />;
}
