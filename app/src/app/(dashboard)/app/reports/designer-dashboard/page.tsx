// /app/src/app/(dashboard)/app/reports/designer-dashboard/page.tsx
//
// Designer Dashboard — App Router + tRPC port. Visible to any signed-in user
// (matches the legacy session-only gate); the tRPC procedure scopes non-managers
// to their own record. Filter-driven, so the server page just gates and renders
// the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DesignerDashboardView } from "./DesignerDashboardView";

export default async function DesignerDashboardPage() {
  await requirePage();
  return <DesignerDashboardView />;
}
