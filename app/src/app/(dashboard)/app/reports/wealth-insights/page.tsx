// /app/src/app/(dashboard)/app/reports/wealth-insights/page.tsx
//
// Wealth Insights — App Router + tRPC port. "See wealth data": wealth is the
// whole report, so the key is the gate (lib/auth/wealthVisibility.ts), as it is
// on its procedure. Filter-driven (clickable tier/signal/level/group chips fetch
// via tRPC), so this server page just gates and renders the view.

import { requirePage } from "@/lib/auth/requirePage";
import { WealthInsightsView } from "./WealthInsightsView";

export default async function WealthInsightsPage() {
  await requirePage(undefined, { permission: "customer.wealth" });
  return <WealthInsightsView />;
}
