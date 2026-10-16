// /app/src/lib/returns/returnDetailContract.ts
//
// What GET /api/returns/[id] sends and the return detail screen reads: one
// definition, imported by both (rule 7), so a field one side renames is a
// compile error instead of a crash. The screen read eight fields the API
// never sent (createdAt, order, payments, ...) and threw "Invalid time value"
// on load (reproduced 2026-10-17).
//
// Types only: no Prisma, so a client component can import it.

export interface ReturnDetail {
  id: number;
  returnNumber: string;
  status: string;
  reason: string;
  reasonNotes: string | null;
  quantity: number;
  /** ISO timestamp. */
  created: string;
  salesOrder: { id: number; orderno: string };
  customer: { id: number; name: string; creditBalance: number } | null;
  product: { name: string; productNumber: string | null } | null;
  pickup: {
    required: boolean;
    address: string | null;
    date: string | null;
    timeSlot: string | null;
    notes: string | null;
  };
  inspection: {
    condition: string | null;
    notes: string | null;
    inspectedBy: string | null;
    inspectedAt: string | null;
  };
  disposition: {
    receivedPlace: string | null;
    restockedAt: string | null;
    restockedPlace: string | null;
    writtenOffAt: string | null;
    writeOffReason: string | null;
  };
  money: ReturnMoney;
  exchangeOrder: { id: number; orderno: string } | null;
  vendorReturnPOs: { id: number; poNumber: string }[];
}

export interface ReturnMoney {
  /** False when the return names no order line: it cannot be valued or refunded. */
  valued: boolean;
  /** Why it cannot be refunded, when it cannot. */
  blockedReason: string | null;
  returnedNet: number;
  returnedTax: number;
  restockingFee: number;
  /** The fee is fixed once the first refund booked the return. */
  feeBooked: boolean;
  /** A nonzero fee needs POS_TRANSACTIONS/"Restocking Fee" mapped. */
  feeAccountMapped: boolean;
  returnOrder: { id: number; orderno: string } | null;
  refunds: ReturnRefund[];
  refundedTotal: number;
  /**
   * What the original order still owes. The next refund pays this first, as
   * store credit spent on that order, before anything goes back to the
   * customer (lib/returns/refundReturn.ts). 0 for a walk-in sale.
   */
  originalOwes: number;
  /** What can be paid out to the customer now, after what the original owes. */
  refundable: number;
  /** Payments on the original order that can still be refunded. */
  payments: { id: number; paymentType: string; cardLast4: string | null; remaining: number }[];
}

export interface ReturnRefund {
  id: number;
  /** ISO timestamp. */
  date: string;
  destination: "ORIGINAL_PAYMENT" | "STORE_CREDIT";
  paymentType: string;
  amount: number;
  status: string | null;
  /** A processor refund that has not confirmed: retry it with the same key. */
  retryable: boolean;
}
