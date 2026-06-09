// /app/src/app/(dashboard)/app/reports/tax-summary/page.tsx
//
// Tax Summary — App Router + tRPC port. Visible to any signed-in user (matches
// the legacy page's session-only gate). Filter-driven, so the server page just
// gates and renders the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TaxSummaryView } from "./TaxSummaryView";

export default async function TaxSummaryPage() {
  await requirePage();
  return <TaxSummaryView />;
}
