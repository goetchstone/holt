// /app/src/app/(dashboard)/app/reports/cross-sell/page.tsx
//
// Cross-Sell Opportunity — App Router + tRPC port. MANAGER/ADMIN, filter-driven
// (data fetches via tRPC on "Run Report"), so this server page just gates and
// renders the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CrossSellView } from "./CrossSellView";

export default async function CrossSellPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <CrossSellView />;
}
