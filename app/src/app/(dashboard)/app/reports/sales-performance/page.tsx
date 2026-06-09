// /app/src/app/(dashboard)/app/reports/sales-performance/page.tsx
//
// Sales Performance — App Router + tRPC port. Visible to any signed-in user
// (matches the legacy session-only gate). Filter-driven, so the server page just
// gates and renders the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { SalesPerformanceView } from "./SalesPerformanceView";

export default async function SalesPerformancePage() {
  await requirePage();
  return <SalesPerformanceView />;
}
