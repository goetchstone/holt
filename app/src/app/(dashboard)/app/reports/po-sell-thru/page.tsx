// /app/src/app/(dashboard)/app/reports/po-sell-thru/page.tsx
//
// PO Sell-Thru — pick purchase orders by number and see how much of what they
// delivered has since sold, windowed from each line's receive date. "View
// management reports"; margin only with "View cost", which the poSellThru
// procedure answers (costVisible), so this page asks for no other key.
// Filter-driven via tRPC, so this server page just gates and renders the
// client view.

import { requirePage } from "@/lib/auth/requirePage";
import { PoSellThruView } from "./PoSellThruView";

export default async function PoSellThruPage() {
  await requirePage(undefined, { permission: "reporting.management" });
  return <PoSellThruView />;
}
