// /app/prisma/seed/demo/orderTools.ts
//
// GAP-07: the invoice tools, so the demo shows them. A handful of the store's
// own order flags (one warns when its order is opened, one switched off once
// orders carry it) and disclaimers, put on the first open orders; and notes on
// a few of their lines.
//
// Flags and disclaimers go through lib/sales/orderFlags.ts and
// lib/sales/orderDisclaimers.ts -- the code Settings and the order page call --
// so the seed cannot write one the routes would refuse, and each leaves the
// change-log row staff's would. Orders are taken by position, no RNG draws, so
// nothing else the seed makes shifts.

import type { PrismaClient } from "@prisma/client";
import { createOrderFlag, setOrderFlags, updateOrderFlag } from "@/lib/sales/orderFlags";
import { addOrderDisclaimer, createDisclaimer } from "@/lib/sales/orderDisclaimers";

const SEED_ACTOR = "seed:demo";

/** A starting set a store edits, not names the code depends on. */
const FLAGS = [
  { name: "Call before delivery", color: "blue", alertOnOpen: false },
  { name: "Fragile", color: "amber", alertOnOpen: false },
  { name: "Balance due on delivery", color: "red", alertOnOpen: true },
  { name: "VIP", color: "purple", alertOnOpen: false },
  { name: "Spring sale", color: "gray", alertOnOpen: false }, // switched off below
] as const;

const DISCLAIMERS = [
  {
    name: "Special order",
    text: "Special order: made to your specifications. It can't be cancelled or returned once it has been ordered from the maker.",
  },
  {
    name: "Sold as-is",
    text: "Sold as-is. This piece is a floor sample and can't be returned or exchanged.",
  },
  {
    name: "Delivery access",
    text: "Please measure doorways, stairs and halls before delivery day. Our crew can't take doors off their hinges or hoist furniture.",
  },
] as const;

const LINE_NOTES = [
  "Legs in walnut",
  "Customer to confirm the fabric swatch before it is ordered",
  "Deliver with the matching ottoman",
] as const;

/** Which flags (by index into FLAGS) each of the first open orders carries. */
const ORDER_FLAGS: readonly (readonly number[])[] = [[0], [2, 3], [1], [0, 1], [4], [2]];

export async function seedOrderTools(
  prisma: PrismaClient,
): Promise<{ flags: number; flagged: number; disclaimers: number; notes: number }> {
  const flagIds: number[] = [];
  for (const [sortOrder, flag] of FLAGS.entries()) {
    const created = await prisma.$transaction((tx) =>
      createOrderFlag(tx, { ...flag, sortOrder }, SEED_ACTOR),
    );
    flagIds.push(created.id);
  }
  const disclaimerIds: number[] = [];
  for (const [sortOrder, disclaimer] of DISCLAIMERS.entries()) {
    const created = await prisma.$transaction((tx) =>
      createDisclaimer(tx, { ...disclaimer, sortOrder }, SEED_ACTOR),
    );
    disclaimerIds.push(created.id);
  }

  const open = await prisma.salesOrder.findMany({
    where: { status: "ORDER" },
    orderBy: { id: "asc" },
    take: ORDER_FLAGS.length,
    select: {
      id: true,
      lineItems: {
        where: { lineItemStatus: "ACTIVE", productId: { not: null } },
        orderBy: { id: "asc" },
        take: 1,
        select: { id: true },
      },
    },
  });

  for (const [i, order] of open.entries()) {
    await prisma.$transaction((tx) =>
      setOrderFlags(tx, {
        salesOrderId: order.id,
        flagIds: ORDER_FLAGS[i].map((f) => flagIds[f]),
        actor: SEED_ACTOR,
      }),
    );
  }
  // Switched off once an order carries it: that order keeps it, no new one is offered it.
  await prisma.$transaction((tx) =>
    updateOrderFlag(tx, flagIds[flagIds.length - 1], { isActive: false }, SEED_ACTOR),
  );

  // The first two open orders are special orders; the third is warned about access.
  let disclaimers = 0;
  for (const [orderIndex, disclaimerIndex] of [
    [0, 0],
    [1, 0],
    [2, 2],
  ] as const) {
    const order = open[orderIndex];
    if (!order) continue;
    await prisma.$transaction((tx) =>
      addOrderDisclaimer(tx, {
        salesOrderId: order.id,
        orderDisclaimerId: disclaimerIds[disclaimerIndex],
        actor: SEED_ACTOR,
      }),
    );
    disclaimers++;
  }

  let notes = 0;
  for (const [i, note] of LINE_NOTES.entries()) {
    const line = open[i]?.lineItems[0];
    if (!line) continue;
    await prisma.orderLineItem.update({ where: { id: line.id }, data: { notes: note } });
    notes++;
  }

  return { flags: flagIds.length, flagged: open.length, disclaimers, notes };
}
