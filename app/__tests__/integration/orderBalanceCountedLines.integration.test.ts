// /app/__tests__/integration/orderBalanceCountedLines.integration.test.ts
//
// calculateOrderBalance is what Stripe checkout (stripe/create-checkout.ts),
// emailed payment links (stripe/send-payment-link.ts) and portal Pay
// (portal/pay.ts) charge. Cancelling a line, or replacing it, changes the
// line's status and leaves its netPrice on the row -- so a balance that summed
// every row charged customers for cancelled lines and charged a replaced line
// twice. Pinned against real Postgres, because the bug lives in which columns
// the query selects as much as in the arithmetic.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { calculateOrderBalance } from "@/lib/paymentService";

describe("an order's balance counts only the lines still owed", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("leaves out cancelled and replaced lines, keeps backordered ones", async () => {
    const order = await prisma.salesOrder.create({ data: { orderno: "SO-BAL", status: "ORDER" } });
    const line = (lineNumber: number, netPrice: number, lineItemStatus: string, vatAmount = 0) =>
      prisma.orderLineItem.create({
        data: {
          salesOrderId: order.id,
          lineNumber,
          productName: `Line ${lineNumber}`,
          orderedQuantity: 1,
          netPrice,
          vatAmount,
          cost: 0,
          lineItemStatus: lineItemStatus as never,
        },
      });
    await line(1, 1000, "ACTIVE", 70);
    await line(2, 400, "CANCELLED", 28); // cancelled: price kept on the row
    await line(3, 800, "REPLACED"); // superseded by line 4
    await line(4, 900, "ACTIVE"); // the replacement
    await line(5, 250, "BACKORDERED"); // still sold
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentAmount: 500,
        paymentType: "Card",
        method: "CARD",
        status: "COMPLETED",
        isRefund: false,
        paymentDate: new Date(),
      },
    });

    const balance = await calculateOrderBalance(order.id);

    // 1000 + 70 vat + 900 + 250 = 2220; the cancelled 400 + 28 and the replaced
    // 800 are not owed.
    expect(balance.totalDue).toBe(2220);
    expect(balance.totalPaid).toBe(500);
    expect(balance.balanceDue).toBe(1720);
  });
});
