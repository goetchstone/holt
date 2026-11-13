// /app/src/lib/labels/soldTag.ts
//
// A "sold" tag (GAP-18): hung on a piece so nobody sells it twice or moves it,
// saying whose it is. It's for a line of a real sale: a quote hasn't sold, and a
// cancelled or replaced line, or one with nothing on it, isn't sold any more
// (rules 31, 33). A gift card sold on the order isn't a piece, so it has no tag.
// What shows is the store's template: customerLastName is there for a tag on a
// showroom floor, where a full name may be more than it wants to show.

import { prisma } from "@/lib/prisma";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { businessDayKey } from "@/lib/reports/businessDay";
import { LabelSetupError } from "./productTag";
import { renderTemplate } from "./renderTemplate";
import { isCountedItemLine } from "@/lib/salesOrderRevenue";

/** Orders that have sold. A returned order's goods aren't on hold for anyone. */
const SOLD_STATUSES: readonly string[] = ["ORDER", "FULFILLED"];

export interface SoldTagLine {
  lineItemStatus: string | null;
  /** Set on a gift card line. */
  giftCardNumber?: string | null;
  orderedQuantity: unknown;
  productName: string | null;
  product: { name: string; productNumber: string; vendor: { name: string } } | null;
}

export interface SoldTagOrder {
  orderno: string;
  status: string;
  orderDate: Date | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  salesPerson: { displayName: string } | null;
}

/** Why this line can't have a sold tag, or null. Pure. */
export function soldTagProblem(status: string, line: SoldTagLine): string | null {
  if (!SOLD_STATUSES.includes(status)) return "Only a sold order's lines can have a sold tag.";
  if (!isCountedItemLine(line)) {
    return line.giftCardNumber
      ? "A gift card isn't a piece, so it has no sold tag."
      : "This line is no longer on the order.";
  }
  if (!(Number(line.orderedQuantity) > 0)) return "This line has nothing on it to tag.";
  return null;
}

/** What a sold tag's template can use. Pure. */
export function soldTagFields(order: SoldTagOrder, line: SoldTagLine, timeZone: string) {
  const first = order.customer?.firstName ?? "";
  const last = order.customer?.lastName ?? "";
  return {
    name: line.product?.name ?? line.productName ?? "",
    sku: line.product?.productNumber ?? "",
    vendor: line.product?.vendor.name ?? "",
    quantity: Number(line.orderedQuantity),
    orderNumber: order.orderno,
    customer: `${first} ${last}`.trim(),
    customerLastName: last,
    soldOn: order.orderDate ? businessDayKey(order.orderDate, timeZone) : "",
    salesperson: order.salesPerson?.displayName ?? "",
  };
}

/** The order's line and how to render its tag, or a refusal with the reason. */
export async function renderSoldTag(
  orderId: number,
  lineItemId: number,
  zplTemplate: string,
): Promise<string> {
  const line = await prisma.orderLineItem.findFirst({
    where: { id: lineItemId, salesOrderId: orderId },
    select: {
      lineItemStatus: true,
      giftCardNumber: true,
      orderedQuantity: true,
      productName: true,
      product: { select: { name: true, productNumber: true, vendor: { select: { name: true } } } },
      salesOrder: {
        select: {
          orderno: true,
          status: true,
          orderDate: true,
          customer: { select: { firstName: true, lastName: true } },
          salesPerson: { select: { displayName: true } },
        },
      },
    },
  });
  if (!line) throw new LabelSetupError("That line isn't on this order.");
  const problem = soldTagProblem(line.salesOrder.status, line);
  if (problem) throw new LabelSetupError(problem);
  const fields = soldTagFields(line.salesOrder, line, await getBusinessTimeZone());
  return renderTemplate(zplTemplate, fields);
}
