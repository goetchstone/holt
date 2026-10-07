// /app/src/app/(dashboard)/app/reports/opportunities/page.tsx
//
// Opportunities hub — App Router + tRPC port. MARKETING/ADMIN (the drilldown
// exposes lead/wealth signals). Tile counts + drilldown via tRPC; "mark as sent"
// stays a REST POST mutation. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { OpportunitiesView } from "./OpportunitiesView";

export default async function OpportunitiesPage() {
  await requirePage(["MARKETING", "ADMIN"]);
  return <OpportunitiesView />;
}
