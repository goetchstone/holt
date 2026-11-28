// /app/src/app/(dashboard)/app/sales/orders/[id]/page.tsx
//
// Sales order detail (summary, status transitions, line-item management,
// invoices, payments, payment links, salesperson reassignment) -- App Router
// port. Opens on "View orders" (sales.read). Reads + writes the shared
// /api/sales/orders/[id] REST endpoints, which stay REST. In Next 16 `params` is
// a Promise, so it must be awaited before reading id. Nested under the batch-A
// /sales/orders list -- distinct path, no collision.

import { requirePage } from "@/lib/auth/requirePage";
import { isModuleEnabled } from "@/lib/modules/requireModule";
import { OrderDetailView } from "./OrderDetailView";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Each guarded control is offered to the holders of the key its route
  // requires, and the route checks it again: undo handover (GAP-07), change
  // salesperson, void a pending payment, create a payment link, generate or
  // text a portal link, and delete a quote. Taking a payment at the register
  // needs the register's page as well as the payment: the page it opens is
  // gated on "Operate register" and on the register being switched on.
  const { holds } = await requirePage(undefined, {
    permission: "sales.read",
    also: [
      "sales.undo-handover",
      "sales.reassign",
      "payment.void",
      "payment.take",
      "pos.operate",
      "sales.write",
      "sales.cancel",
    ],
  });
  const canTakeAtRegister =
    holds["payment.take"] && holds["pos.operate"] && (await isModuleEnabled("pos"));
  return (
    <OrderDetailView
      id={id}
      canUndoHandover={holds["sales.undo-handover"]}
      canReassign={holds["sales.reassign"]}
      canVoidPayment={holds["payment.void"]}
      canSendPaymentLink={holds["payment.take"]}
      canTakeAtRegister={canTakeAtRegister}
      canPortalLink={holds["sales.write"]}
      canDeleteQuote={holds["sales.cancel"]}
    />
  );
}
