// /app/src/app/(dashboard)/app/reports/unmapped-payments/page.tsx
//
// Unmapped Payments — accounting exception report. Lists tender strings with
// no POS_PAYMENTS GL mapping, which generateSalesJournal drops from the sales
// journal with only a warning. Same MANAGER/ADMIN gate and shape as
// Unclassified Returns; the server page gates and renders the client view.

import { requirePage } from "@/lib/auth/requirePage";
import { UnmappedPaymentsView } from "./UnmappedPaymentsView";

export default async function UnmappedPaymentsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <UnmappedPaymentsView />;
}
