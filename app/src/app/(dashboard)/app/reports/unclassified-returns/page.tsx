// /app/src/app/(dashboard)/app/reports/unclassified-returns/page.tsx
//
// Unclassified Returns — B3 exception report. Lists return-shaped lines
// booked on the default-restock assumption because no Return record
// classifies them (imported/historical returns, or a Return that hasn't
// been inspected yet). MANAGER/ADMIN, filter-driven via tRPC (the report
// runs on "Run Report"), so this server page just gates and renders the
// client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { UnclassifiedReturnsView } from "./UnclassifiedReturnsView";

export default async function UnclassifiedReturnsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <UnclassifiedReturnsView />;
}
