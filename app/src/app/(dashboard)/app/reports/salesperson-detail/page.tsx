// /app/src/app/(dashboard)/app/reports/salesperson-detail/page.tsx
//
// Salesperson Detail — App Router + tRPC port. Visible to any signed-in user
// (matches the legacy session-only gate); the tRPC procedure scopes non-managers
// to their own record. Filter-driven, so the server page just gates and renders
// the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { SalespersonDetailView } from "./SalespersonDetailView";

export default async function SalespersonDetailPage() {
  await requirePage();
  return <SalespersonDetailView />;
}
