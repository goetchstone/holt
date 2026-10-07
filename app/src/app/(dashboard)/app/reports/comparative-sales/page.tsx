// /app/src/app/(dashboard)/app/reports/comparative-sales/page.tsx
//
// Comparative Sales — App Router + tRPC port. MANAGER/ADMIN, filter-driven (data
// fetches via tRPC on "Run Report"), so this server page just gates and renders
// the client view. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ComparativeSalesView } from "./ComparativeSalesView";

export default async function ComparativeSalesPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <ComparativeSalesView />;
}
