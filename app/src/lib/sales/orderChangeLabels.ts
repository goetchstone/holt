// /app/src/lib/sales/orderChangeLabels.ts
//
// What each OrderChangeLog.changeType is called on a screen: an order's history and
// the audit trail read the same list (rule 37).

const ORDER_CHANGE_LABELS: Record<string, string> = {
  STATUS_CHANGE: "Status Changed",
  LINE_ADDED: "Line Added",
  LINE_CANCELLED: "Line Cancelled",
  LINE_REPLACED: "Line Replaced",
  LINE_REMOVED: "Line Removed",
  PRICE_CHANGE: "Price/Qty Changed",
  NOTE_ADDED: "Note Added",
  LINE_NOTE: "Line Note",
  FLAG_ADDED: "Flagged",
  FLAG_REMOVED: "Flag Taken Off",
  DISCLAIMER_ADDED: "Disclaimer Added",
  DISCLAIMER_REMOVED: "Disclaimer Taken Off",
  COPIED_FROM: "Copied From",
  HANDED_OVER: "Handed Over",
  HANDOVER_UNDONE: "Handover Undone",
  PARTLY_DELIVERED: "Partly Delivered",
  SALESPERSON_CHANGE: "Salesperson Changed",
  HOLD_SET: "Held for Customer",
  HOLD_ENDED: "Hold Taken Off",
  DISCOUNT_APPROVED: "Discount Approved",
  PRODUCT_RELINKED: "Product Relinked",
  REFUND_ISSUED: "Refund Issued",
  PAYMENT_VOIDED: "Payment Voided",
  PO_CANCELLED: "PO Cancelled",
  PO_KEPT: "PO Kept for Stock",
  RETURN_INITIATED: "Return Started",
  RETURN_BOOKED: "Return Booked",
  RETURN_REFUND_ISSUED: "Return Refunded",
  RETURN_EXCHANGE_CREATED: "Exchange Created",
};

export function orderChangeLabel(changeType: string): string {
  return ORDER_CHANGE_LABELS[changeType] ?? changeType;
}
