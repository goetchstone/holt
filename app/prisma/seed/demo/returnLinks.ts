// /app/prisma/seed/demo/returnLinks.ts
//
// One return link sent to a customer two days ago and not answered yet: the
// rows POST /api/sales/orders/[id]/return-link writes, an INITIATED return
// carrying a portal token, and the order's RETURN_INITIATED change-log row. It
// gives the public return pages (/portal/return/[token], and its status page)
// a return to show, with the request form still open
// (docs/testing/page-sweep.md).
//
// The order is the most recent delivered one, out at least three days, with
// nothing returned from it. The link names the order's first line that is
// goods (COUNTED_ITEM_LINE: not cancelled, replaced or a gift card), as staff
// would when sending it for one piece. Like the endpoint, no product snapshot
// is written.
//
// The token is deterministic and draws no RNG, like the seeded tickets' tokens
// (operations.ts), so anyone can read it from this public repository and open
// that one invented return on a public demo. Never copy the shape outside the
// seed: a real link's token is a random UUID. The return number comes from the
// wall clock, as the endpoint's does.

import type { PrismaClient } from "@prisma/client";
import { COUNTED_ITEM_LINE } from "@/lib/salesOrderRevenue";
import { generateReturnNumber } from "@/lib/returnService";

const SEED_ACTOR = "seed:demo";
const DAY_MS = 86_400_000;

export async function seedReturnLink(
  prisma: PrismaClient,
  now: Date,
): Promise<{ returnNumber: string }> {
  // A piece that can be sent back: counted, a product, and something ordered.
  const returnable = {
    ...COUNTED_ITEM_LINE,
    productId: { not: null },
    orderedQuantity: { gt: 0 },
  };
  const order = await prisma.salesOrder.findFirst({
    where: {
      status: "FULFILLED",
      deliveryMethod: "DELIVERY",
      customerId: { not: null },
      deliveredAt: { lte: new Date(now.getTime() - 3 * DAY_MS) },
      returns: { none: {} },
      lineItems: { some: returnable },
    },
    orderBy: [{ deliveredAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      orderno: true,
      customerId: true,
      lineItems: {
        where: returnable,
        orderBy: { lineNumber: "asc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  if (!order) {
    throw new Error(
      "seed invariant: no delivered order to send a return link for (returnLinks.ts)",
    );
  }

  const returnNumber = await generateReturnNumber();
  const requestedAt = new Date(now.getTime() - 2 * DAY_MS);
  await prisma.$transaction(async (tx) => {
    await tx.return.create({
      data: {
        returnNumber,
        status: "INITIATED",
        reason: "OTHER",
        salesOrderId: order.id,
        customerId: order.customerId,
        lineItemId: order.lineItems[0]?.id ?? null,
        portalToken: `seed-return-${order.orderno}`,
        portalRequestedAt: requestedAt,
        created: requestedAt,
        createdBy: SEED_ACTOR,
      },
    });
    await tx.orderChangeLog.create({
      data: {
        salesOrderId: order.id,
        changeType: "RETURN_INITIATED",
        newValue: returnNumber,
        reason: "Return portal link generated",
        changedBy: SEED_ACTOR,
        created: requestedAt,
      },
    });
  });
  return { returnNumber };
}
