// /app/src/app/(dashboard)/app/reports/designer-dashboard/page.tsx
//
// Designer Dashboard — App Router + tRPC port. Gated on "View reports", as its
// tRPC procedure is; the average margin needs "View cost" too (SEC-14). The
// procedure scopes non-managers to their own record. Filter-driven, so the server page just gates and renders
// the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DesignerDashboardView } from "./DesignerDashboardView";

export default async function DesignerDashboardPage() {
  await requirePage(undefined, { permission: "reporting.read" });
  return <DesignerDashboardView />;
}
