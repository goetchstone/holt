// /app/src/app/(dashboard)/app/reports/wealth-insights/page.tsx
//
// Wealth Insights — App Router + tRPC port. ADMIN/MARKETING (wealth data is
// never exposed to other roles). Filter-driven (clickable tier/signal/level/group
// chips fetch via tRPC), so this server page just gates and renders the view.

import { requirePage } from "@/lib/auth/requirePage";
import { WealthInsightsView } from "./WealthInsightsView";

export default async function WealthInsightsPage() {
  await requirePage(["ADMIN", "MARKETING"]);
  return <WealthInsightsView />;
}
