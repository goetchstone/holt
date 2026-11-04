// /app/src/app/(dashboard)/app/purchasing/low-stock/page.tsx
//
// Purchasing -> Low Stock (GAP-14): what's below the level kept at each store.
// Whoever reads purchasing sees it; whoever writes it (the key /api/scan/order
// files with) can order from it. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { LowStockView } from "./LowStockView";

export default async function LowStockPage() {
  const { holds } = await requirePage(undefined, {
    permission: "purchasing.read",
    also: ["purchasing.write"],
  });
  return <LowStockView canOrder={holds["purchasing.write"]} />;
}
