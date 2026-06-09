// /app/src/app/(dashboard)/app/reports/top-sellers/page.tsx
//
// Top & Bottom Sellers — products ranked by units, revenue, or margin.
// MANAGER/ADMIN, filter-driven via tRPC. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TopSellersView } from "./TopSellersView";

export default async function TopSellersPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <TopSellersView />;
}
