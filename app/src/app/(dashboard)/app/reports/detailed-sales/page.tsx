// /app/src/app/(dashboard)/app/reports/detailed-sales/page.tsx
//
// Detailed Sales (Sales by Department) — App Router + tRPC port. Visible to any
// signed-in user (matches the legacy withAuth() session-only gate). Filter +
// drilldown driven, so the server page just gates and renders the client view.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DetailedSalesView } from "./DetailedSalesView";

export default async function DetailedSalesPage() {
  await requirePage();
  return <DetailedSalesView />;
}
