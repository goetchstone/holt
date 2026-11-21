// /app/src/lib/returns/returnLine.ts
//
// Which order line a return may be for. A return is valued from its line when
// staff pay it out (bookReturn.ts reads the line's price, tax and cost), so the
// line is not a label: pointing a return at someone else's line, or at a line
// that was cancelled, would refund the wrong goods.
//
// Three routes write Return.lineItemId from what a caller sends. Two ask
// returnLineProblem: the customer portal's return request (a token holder, no
// session) and the staff return-link endpoint, so the link and the request
// cannot disagree. The third does not: POST /api/returns (staff New return)
// finds the line within the order, refuses the delivery fee and defers a gift
// card to the store's "Refund unused gift cards" setting, but takes a
// cancelled, replaced or zero-quantity line. So this is not yet one guard on
// every path (CLAUDE.md rule 42); docs/domains/returns.md, "Known gaps",
// tracks it. Moving New return onto this function needs care: it refuses
// every gift card, where New return honours the store's setting.
//
// A line may be the return's when it is:
//
//   - on the return's own order;
//   - still counted, through the shared filter (rule 33: not cancelled or
//     replaced) with a quantity above zero (rule 31: a zero-quantity line is a
//     cancelled line);
//   - goods: COUNTED_ITEM_LINE's item kind leaves a gift card out, and the
//     order's delivery fee is no goods to send back either, as POST
//     /api/returns already refuses it.

import type { Prisma, PrismaClient } from "@prisma/client";
import { isCountedItemLine } from "@/lib/salesOrderRevenue";

type Db = PrismaClient | Prisma.TransactionClient;

/** What the portal request and the return link answer when the line id sent is not one. */
export const LINE_ITEM_ID_ERROR = "lineItemId must be a whole number above zero";

/** A line id as a request may carry one: a whole number above zero. */
export function isLineItemId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Why `lineItemId` cannot be the line of a return on `salesOrderId`, or null when it can. */
export async function returnLineProblem(
  db: Db,
  salesOrderId: number,
  lineItemId: number,
): Promise<string | null> {
  const line = await db.orderLineItem.findUnique({
    where: { id: lineItemId },
    select: {
      salesOrderId: true,
      lineItemStatus: true,
      giftCardNumber: true,
      orderedQuantity: true,
      deliveryFeeFor: { select: { id: true } },
    },
  });
  // A line that does not exist answers the same as another order's, so the
  // answer says nothing about lines beyond this order.
  if (!line || line.salesOrderId !== salesOrderId) {
    return "That line isn't on the order this return is for.";
  }
  if (!isCountedItemLine(line) || !line.orderedQuantity.gt(0) || line.deliveryFeeFor) {
    return "That line can't be returned: it was cancelled or replaced, or it is a gift card or the order's delivery fee.";
  }
  return null;
}
