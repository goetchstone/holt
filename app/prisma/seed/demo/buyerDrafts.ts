// /app/prisma/seed/demo/buyerDrafts.ts
//
// One closed stock buy, rebuilt from the purchase orders that filled it, so the
// buyer-drafts archive lists a buy and its performance report has one to report
// on. Without it, Admin > Buyer Drafts > Archive was empty and the per-buy
// performance page could not be opened at all (docs/testing/page-sweep.md).
//
// Built the way a buyer builds one from history, through the product's own code:
// the buy through the create shape the buys API uses (buildBuyCreateData), and
// each purchase order through lib/historicalPoImport.ts, with the three writes
// pages/api/admin/buyer-drafts/import-purchase-order.ts makes in one
// transaction: the draft PO, its items, and the link to the real PO.
//
// The purchase orders are the latest stock orders placed at least 90 days ago
// and received in full, so the goods have been on the floor long enough to
// have sold. Stock orders only: a special order (salesOrderId set) was bought
// for one customer and is not part of a seasonal buy. The buy closed when the
// last of their goods came in.
//
// No RNG draws, so nothing the seed made before it shifts.

import type { PrismaClient } from "@prisma/client";
import { buildBuyCreateData } from "@/lib/buyerDraftRequestBody";
import { draftSpend } from "@/lib/buyerDraftQty";
import { buildImportFromPurchaseOrder } from "@/lib/historicalPoImport";

const SEED_ACTOR = "seed:demo";
const DAY_MS = 86_400_000;

/** How many received stock orders make up the buy. */
const POS_PER_BUY = 3;
/** How long before its first order a buy is kicked off. */
const KICKOFF_LEAD_DAYS = 21;

export interface BuyerDraftsResult {
  buys: number;
  draftPos: number;
  items: number;
}

/**
 * The season a buy is named for, from the month its first order went out. The
 * names are the ones the buy form offers (components/buyer-drafts/DraftBuyModal.tsx).
 */
function seasonOf(date: Date): string {
  const month = date.getUTCMonth(); // 0 is January
  if (month === 11 || month <= 1) return "Winter";
  if (month <= 4) return "Spring";
  if (month <= 7) return "Summer";
  return "Fall";
}

export async function seedBuyerDrafts(prisma: PrismaClient, now: Date): Promise<BuyerDraftsResult> {
  // The same read the import route makes of each purchase order
  // (import-purchase-order.ts), newest first.
  const pos = await prisma.purchaseOrder.findMany({
    where: {
      salesOrderId: null,
      status: "RECEIVED_FULL",
      orderDate: { lte: new Date(now.getTime() - 90 * DAY_MS) },
      lineItems: { some: { productId: { not: null } } },
    },
    orderBy: [{ orderDate: "desc" }, { id: "asc" }],
    take: POS_PER_BUY,
    select: {
      id: true,
      poNumber: true,
      vendorId: true,
      vendor: { select: { name: true } },
      orderDate: true,
      expectedDelivery: true,
      estimatedShipDate: true,
      status: true,
      notes: true,
      lineItems: {
        select: {
          id: true,
          productId: true,
          orderedQuantity: true,
          unitCost: true,
          partNo: true,
          productName: true,
          product: {
            select: { id: true, productNumber: true, name: true, baseRetail: true },
          },
        },
      },
    },
  });
  if (pos.length === 0) {
    throw new Error("seed invariant: no received stock PO to rebuild a buy from (buyerDrafts.ts)");
  }

  const built = pos.map((po) => buildImportFromPurchaseOrder(po));
  const allItems = built.flatMap((b) => b.draftItems);

  const oldest = pos[pos.length - 1].orderDate;
  const season = seasonOf(oldest);
  const year = oldest.getUTCFullYear();
  const kickoff = new Date(oldest.getTime() - KICKOFF_LEAD_DAYS * DAY_MS);
  // Closed once the last of its goods came in. The newest order is not always
  // that one: a faster vendor's goods land first.
  const lastReceipt = await prisma.receivingRecord.aggregate({
    where: { purchaseOrderId: { in: pos.map((po) => po.id) } },
    _max: { receivedDate: true },
  });
  const closedAt =
    lastReceipt._max.receivedDate ??
    new Date(Math.max(...pos.map((po) => (po.expectedDelivery ?? po.orderDate).getTime())));
  // A budget a buyer would have set: what it spent, plus some headroom, in
  // round thousands.
  const spent = draftSpend(allItems.map((i) => ({ qty: i.qty, cost: Number(i.cost) })));
  const budget = Math.ceil((spent * 1.15) / 1000) * 1000;

  const buy = await prisma.buyerDraftBuy.create({
    data: {
      ...buildBuyCreateData(
        {
          name: `${season} ${year} Stock Buy`,
          season,
          year,
          budget,
          status: "CLOSED",
          kickoff,
          closedAt,
        },
        SEED_ACTOR,
      ),
      created: kickoff,
      // The last edit was closing it. The archive shows a buy's `updated` as
      // the date it closed (pages/api/admin/buyer-drafts/buys/archive.ts).
      updated: closedAt,
    },
    select: { id: true },
  });

  for (const b of built) {
    await prisma.$transaction(async (tx) => {
      const draftPo = await tx.buyerDraftPurchaseOrder.create({
        data: {
          ...b.draftPo,
          buyId: buy.id,
          createdBy: SEED_ACTOR,
          updatedBy: SEED_ACTOR,
        },
        select: { id: true },
      });
      if (b.draftItems.length > 0) {
        await tx.buyerDraftItem.createMany({
          data: b.draftItems.map((item) => ({
            ...item,
            draftPoId: draftPo.id,
            createdBy: SEED_ACTOR,
            updatedBy: SEED_ACTOR,
          })),
        });
      }
      await tx.buyerDraftPoRealPoLink.create({
        data: {
          draftPoId: draftPo.id,
          realPoId: b.realPoIdForLink,
          linkSource: "HISTORICAL_IMPORT",
          createdBy: SEED_ACTOR,
          updatedBy: SEED_ACTOR,
        },
      });
    });
  }

  return { buys: 1, draftPos: built.length, items: allItems.length };
}
