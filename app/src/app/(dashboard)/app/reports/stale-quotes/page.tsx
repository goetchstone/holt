// /app/src/app/(dashboard)/app/reports/stale-quotes/page.tsx
//
// Stale Quote Cleanup report — App Router + tRPC port. ADMIN only, filter-driven
// (the data fetches via tRPC on "Run Report"), so this server page just gates
// and renders the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { StaleQuotesView } from "./StaleQuotesView";

export default async function StaleQuotesPage() {
  await requirePage(["ADMIN"]);
  return <StaleQuotesView />;
}
