// /app/src/app/(dashboard)/app/purchasing/orders/new/page.tsx
//
// GAP-01: write a stock purchase order by hand. "Write purchase orders"; the
// editor shows cost to a holder of "View cost". The server page gates and
// loads the vendors and stores; PurchaseOrderEditor does the rest.

import { requirePage } from "@/lib/auth/requirePage";
import { poEditorOptions } from "@/lib/purchasing/stockPurchaseOrder";
import { PurchaseOrderEditor } from "../PurchaseOrderEditor";

export default async function NewPurchaseOrderPage() {
  const { holds } = await requirePage(undefined, {
    permission: "purchasing.write",
    also: ["catalog.cost"],
  });
  const { vendors, stores } = await poEditorOptions();
  return (
    <PurchaseOrderEditor vendors={vendors} stores={stores} costVisible={holds["catalog.cost"]} />
  );
}
