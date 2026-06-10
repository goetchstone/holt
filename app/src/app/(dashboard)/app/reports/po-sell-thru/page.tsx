// /app/src/app/(dashboard)/app/reports/po-sell-thru/page.tsx
//
// PO Sell-Thru — pick purchase orders by number and see how much of what they
// delivered has since sold, windowed from each line's receive date. MANAGER/
// ADMIN (exposes cost + margin). Filter-driven via tRPC, so this server page
// just gates and renders the client view.

import { requirePage } from "@/lib/auth/requirePage";
import { PoSellThruView } from "./PoSellThruView";

export default async function PoSellThruPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <PoSellThruView />;
}
