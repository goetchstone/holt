// /app/src/app/(dashboard)/app/reports/stale-quotes/page.tsx
//
// Stale Quote Cleanup report — App Router + tRPC port. "View financial reports"
// (an ADMIN-only role list until the 2026-11 sweep), filter-driven (the data
// fetches via tRPC on "Run Report"), so this server page just gates and renders
// the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { StaleQuotesView } from "./StaleQuotesView";

export default async function StaleQuotesPage() {
  await requirePage(undefined, { permission: "reporting.financial" });
  return <StaleQuotesView />;
}
