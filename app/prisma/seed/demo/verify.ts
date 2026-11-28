// /app/prisma/seed/demo/verify.ts
//
// The demo seed checks what it wrote before it says it is done.
//
// `npm run seed:coverage` asks whether each table has rows. It cannot see a
// row that is there and wrong, and several of those sat in every demo
// database: thirty staff with a role name and no role, two quotes sold by
// "seed:demo", every delivered order with nothing marked as handed over, stock
// held for an order that had already gone home, and delivery orders with
// nobody to deliver to. Each check below is one of those, stated as what must
// be true of a seeded database. A failure stops the seed with every violation
// listed, so a wrong demo is not handed to someone as a finished one. CI's
// setup step (`npm run setup`) runs the seed, so these run on every pull
// request.
//
// Add a check here when a wrong-but-present row is found. Say what must be
// true, not what the bug was.

import type { PrismaClient } from "@prisma/client";
import { COUNTED_ITEM_LINE } from "@/lib/salesOrderRevenue";
import { toQty } from "@/lib/inventory/quantity";

/** How many of one kind of problem are spelled out before the rest are counted. */
const LISTED = 5;

/** The first few in full, then how many more there are. */
function listed(rows: string[]): string[] {
  if (rows.length <= LISTED) return rows;
  return [...rows.slice(0, LISTED), `... and ${rows.length - LISTED} more of the same kind.`];
}

/** Every staff member is on the Role their role name says. */
async function staffOffTheirRole(prisma: PrismaClient): Promise<string[]> {
  const staff = await prisma.staffMember.findMany({
    orderBy: { id: "asc" },
    select: { displayName: true, role: true, roleRef: { select: { key: true } } },
  });
  return staff
    .filter((member) => member.roleRef?.key !== member.role)
    .map(
      (member) =>
        `Staff member "${member.displayName}" has role ${member.role} but is linked to ` +
        `${member.roleRef ? `Role "${member.roleRef.key}"` : "no Role"}.`,
    );
}

/**
 * Every order with a seller names them both ways, and the two agree: the staff
 * member and their name, as an order written through the application carries
 * them (lib/sales/orderSeller.ts).
 */
async function ordersWithoutTheirSeller(prisma: PrismaClient): Promise<string[]> {
  const orders = await prisma.salesOrder.findMany({
    where: { OR: [{ salesperson: { not: null } }, { salesPersonId: { not: null } }] },
    orderBy: { id: "asc" },
    select: { orderno: true, salesperson: true, salesPerson: { select: { displayName: true } } },
  });
  return orders
    .filter((order) => order.salesPerson?.displayName !== order.salesperson)
    .map(
      (order) =>
        `Order ${order.orderno} names the salesperson ${JSON.stringify(order.salesperson)} and is ` +
        `linked to ${order.salesPerson ? `"${order.salesPerson.displayName}"` : "no staff member"}.`,
    );
}

/**
 * A delivered order has its delivered date and all its goods handed over; an
 * order still open has neither, as lib/fulfilment/handover.ts leaves them.
 */
async function ordersNotHandedOverAsTheySay(prisma: PrismaClient): Promise<string[]> {
  const orders = await prisma.salesOrder.findMany({
    where: { status: { in: ["ORDER", "FULFILLED"] } },
    orderBy: { id: "asc" },
    select: {
      orderno: true,
      status: true,
      deliveredAt: true,
      lineItems: {
        where: { ...COUNTED_ITEM_LINE, productId: { not: null }, orderedQuantity: { gt: 0 } },
        select: { orderedQuantity: true, fulfilledQty: true },
      },
    },
  });
  const problems: string[] = [];
  for (const order of orders) {
    const delivered = order.status === "FULFILLED";
    if (delivered !== (order.deliveredAt !== null)) {
      problems.push(
        `Order ${order.orderno} is ${order.status} ${order.deliveredAt ? "with" : "without"} a delivered date.`,
      );
      continue;
    }
    const ordered = order.lineItems.reduce((sum, l) => sum + toQty(l.orderedQuantity), 0);
    const handedOver = order.lineItems.reduce((sum, l) => sum + toQty(l.fulfilledQty ?? 0), 0);
    const over = order.lineItems.some((l) => toQty(l.fulfilledQty ?? 0) > toQty(l.orderedQuantity));
    // Delivered: all of it. Open: some of it at most, or it would be delivered.
    const right = delivered ? handedOver === ordered : handedOver < ordered || ordered === 0;
    if (over || !right) {
      problems.push(
        `Order ${order.orderno} is ${order.status} with ${handedOver} of ${ordered} handed over.`,
      );
    }
  }
  return problems;
}

/**
 * Stock is held only for a quote or an order still waiting for it, and never
 * more of a product than its lines are waiting for.
 */
async function stockHeldForNoReason(prisma: PrismaClient): Promise<string[]> {
  const held = await prisma.inventoryPosition.groupBy({
    by: ["salesOrderId", "productId"],
    where: { salesOrderId: { not: null }, quantity: { gt: 0 } },
    _sum: { quantity: true },
    orderBy: [{ salesOrderId: "asc" }, { productId: "asc" }],
  });
  const orderIds = [
    ...new Set(held.flatMap((h) => (h.salesOrderId == null ? [] : h.salesOrderId))),
  ];
  const orders = await prisma.salesOrder.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      orderno: true,
      status: true,
      lineItems: {
        where: { ...COUNTED_ITEM_LINE, productId: { not: null }, orderedQuantity: { gt: 0 } },
        select: { productId: true, orderedQuantity: true, fulfilledQty: true },
      },
    },
  });
  const byId = new Map(orders.map((order) => [order.id, order]));
  const problems: string[] = [];
  for (const row of held) {
    const order = row.salesOrderId == null ? undefined : byId.get(row.salesOrderId);
    if (!order) continue;
    const quantity = toQty(row._sum.quantity ?? 0);
    if (order.status !== "ORDER" && order.status !== "QUOTE") {
      problems.push(
        `${quantity} of product ${row.productId} is held for order ${order.orderno}, which is ${order.status}.`,
      );
      continue;
    }
    const waitingFor = order.lineItems
      .filter((line) => line.productId === row.productId)
      .reduce((sum, l) => sum + toQty(l.orderedQuantity) - toQty(l.fulfilledQty ?? 0), 0);
    if (quantity > waitingFor) {
      problems.push(
        `${quantity} of product ${row.productId} is held for order ${order.orderno}, ` +
          `which is waiting for ${waitingFor}.`,
      );
    }
  }
  return problems;
}

/** An order that is delivered or collected names the customer it is for. */
async function deliveriesToNobody(prisma: PrismaClient): Promise<string[]> {
  const orders = await prisma.salesOrder.findMany({
    where: { customerId: null, deliveryMethod: { in: ["DELIVERY", "PICKUP"] } },
    orderBy: { id: "asc" },
    select: { orderno: true, deliveryMethod: true },
  });
  return orders.map(
    (order) => `Order ${order.orderno} is for ${order.deliveryMethod} and names no customer.`,
  );
}

export async function seedProblems(prisma: PrismaClient): Promise<string[]> {
  const checks = [
    staffOffTheirRole,
    ordersWithoutTheirSeller,
    ordersNotHandedOverAsTheySay,
    stockHeldForNoReason,
    deliveriesToNobody,
  ];
  const problems: string[] = [];
  for (const check of checks) problems.push(...listed(await check(prisma)));
  return problems;
}

/** Throws, listing every problem, when the seeded data is not as it should be. */
export async function assertSeedIsSound(prisma: PrismaClient): Promise<void> {
  const problems = await seedProblems(prisma);
  if (problems.length === 0) return;
  throw new Error(
    `The demo seed wrote data that is not right (${problems.length} problem(s)):\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
}
