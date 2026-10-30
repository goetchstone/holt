// /app/src/app/(dashboard)/app/purchasing/orders/[id]/edit/page.tsx
//
// GAP-01: change a purchase order -- ship-to, expected date, notes and lines --
// until anything is received against it. "Write purchase orders"; the editor
// shows cost to a holder of "View cost". In Next 16 `params` is a Promise.

import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { loadPoForEditor, poEditorOptions } from "@/lib/purchasing/stockPurchaseOrder";
import { PurchaseOrderEditor } from "../../PurchaseOrderEditor";

export default async function EditPurchaseOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { holds } = await requirePage(undefined, {
    permission: "purchasing.write",
    also: ["catalog.cost"],
  });
  const poId = Number.parseInt(id, 10);
  const po = Number.isNaN(poId) ? null : await loadPoForEditor(poId, holds["catalog.cost"]);
  if (!po) notFound();
  const { stores } = await poEditorOptions();
  return (
    <PurchaseOrderEditor vendors={[]} stores={stores} costVisible={holds["catalog.cost"]} po={po} />
  );
}
