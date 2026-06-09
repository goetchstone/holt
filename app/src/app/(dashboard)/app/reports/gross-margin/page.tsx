// /app/src/app/(dashboard)/app/reports/gross-margin/page.tsx
//
// Gross Margin — revenue vs cost by department or vendor. MANAGER/ADMIN,
// filter-driven (data fetches via tRPC on "Run Report"), so this server page just
// gates and renders the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { GrossMarginView } from "./GrossMarginView";

export default async function GrossMarginPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <GrossMarginView />;
}
