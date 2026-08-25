// /app/prisma/seed/demo/inventoryOps.ts
//
// What happens to inventory AFTER the positions exist: counting it, moving it,
// freezing it, and the record of every time the truth and the system disagreed.
//
// inventory.ts seeds the standing position -- what is on hand and where. This
// file seeds the operational history around it, and every model here exists
// because of a specific thing that goes wrong in a real warehouse:
//
//   EXCEPTIONS -- "the sale always wins". A cashier who scans an item the
//     system says is not there still sells it; the discrepancy becomes
//     back-office work rather than a checkout interruption. An
//     InventoryException IS that back-office work. Seeded both resolved and
//     open, because an exceptions queue with nothing open cannot show that it
//     is a queue, and one with nothing resolved cannot show the resolution
//     path exists.
//
//   TRANSFERS -- stock moving between stock locations and between stores.
//     Seeded across all four states, and crucially some carry a salesOrderId:
//     a transfer that exists BECAUSE a customer bought something is a different
//     record from a stock rebalance, and the two read differently on screen.
//     IN_TRANSIT ones matter most -- that stock is in neither place, which is
//     exactly the state a naive report double-counts or loses.
//
//   PHYSICAL COUNTS + UNIDENTIFIED SCANS -- the count itself. An unidentified
//     scan is what a counter produces when they scan something the catalog does
//     not know: a photo, a location, and no product. Without them the
//     reconciliation screen has nothing to reconcile, and "we scanned something
//     nobody can identify" is the single most common real count outcome.
//
//   FREEZES -- a count is taken against a frozen picture of stock, or the
//     numbers move under you while you count. A completed freeze and an
//     in-progress one, because those are different screens.
//
//   SNAPSHOTS -- the historical series every inventory-value report reads. One
//     snapshot is a number; a series is a trend, and the report is a trend
//     report. Seeded from both sources (LOCAL and IMPORT) since a deployment
//     that imports its counts and one that takes them natively are both real.

import type { PrismaClient, InventoryTransferStatus, InventoryFreezeStatus } from "@prisma/client";
import type { Rng } from "./rng";
import { pick, randInt, subRng } from "./rng";
import type { CatalogProduct } from "./catalog";
import type { StoreSetup } from "./locations";
import type { StaffSetup } from "./staff";

const SEED_ACTOR = "seed:demo";

const RESOLUTIONS = [
  "Found in the back bay, position corrected.",
  "Vendor shipped short; PO amended and customer notified.",
  "Miscount at receiving; adjusted against the freeze.",
  "Damaged in transit, written off and reordered.",
];

const SCAN_LOCATIONS = [
  "Receiving bay",
  "Back stock aisle 3",
  "Showroom floor",
  "Overflow trailer",
];

export interface InventoryOpsResult {
  exceptionsCreated: number;
  openExceptions: number;
  transfersCreated: number;
  inTransitTransfers: number;
  orderLinkedTransfers: number;
  countsCreated: number;
  unidentifiedScans: number;
  freezesCreated: number;
  freezeItemsCreated: number;
  snapshotsCreated: number;
}

export async function seedInventoryOps(
  prisma: PrismaClient,
  rng: Rng,
  products: CatalogProduct[],
  stores: StoreSetup[],
  staff: StaffSetup,
  today: Date,
): Promise<InventoryOpsResult> {
  const oRng = subRng(rng, "inventoryOps");
  const result: InventoryOpsResult = {
    exceptionsCreated: 0,
    openExceptions: 0,
    transfersCreated: 0,
    inTransitTransfers: 0,
    orderLinkedTransfers: 0,
    countsCreated: 0,
    unidentifiedScans: 0,
    freezesCreated: 0,
    freezeItemsCreated: 0,
    snapshotsCreated: 0,
  };

  if (products.length === 0 || stores.length === 0) return result;

  const warehouseStaff = staff.warehouseStaff.length > 0 ? staff.warehouseStaff : staff.all;
  const actorUserId = warehouseStaff[0]?.userId ?? staff.all[0]?.userId;
  if (!actorUserId) return result;

  // ---- oversell exceptions ----------------------------------------------
  // Real orders, so the queue links somewhere. Without an order the exception
  // is an orphan row and the "go look at this" action has nowhere to go.
  const soldOrders = await prisma.salesOrder.findMany({
    where: {
      status: { in: ["ORDER", "FULFILLED"] },
      lineItems: { some: { productId: { not: null } } },
    },
    select: {
      id: true,
      storeLocationId: true,
      lineItems: {
        where: { productId: { not: null } },
        select: { productId: true, orderedQuantity: true },
        take: 1,
      },
    },
    orderBy: { orderDate: "desc" },
    take: 14,
  });

  for (const [i, order] of soldOrders.entries()) {
    const line = order.lineItems[0];
    if (!line?.productId) continue;
    const storeLocationId = order.storeLocationId ?? stores[0].id;
    const requested = Math.max(1, Math.round(Number(line.orderedQuantity ?? 1)));
    const allocated = randInt(oRng, 0, Math.max(0, requested - 1));
    // ~40% still open. A queue that is all-resolved shows an empty default view.
    const resolved = i % 5 !== 0 && i % 5 !== 1;
    const occurredAt = new Date(today.getTime() - randInt(oRng, 1, 60) * 86_400_000);

    await prisma.inventoryException.create({
      data: {
        salesOrderId: order.id,
        productId: line.productId,
        storeLocationId,
        requested,
        allocated,
        shortfall: requested - allocated,
        occurredAt,
        resolvedAt: resolved ? new Date(occurredAt.getTime() + 3 * 86_400_000) : null,
        resolvedBy: resolved ? SEED_ACTOR : null,
        resolutionNote: resolved ? pick(oRng, RESOLUTIONS) : null,
      },
    });
    result.exceptionsCreated += 1;
    if (!resolved) result.openExceptions += 1;
  }

  // ---- transfers, including ones raised for a customer order ------------
  const transferStates: InventoryTransferStatus[] = [
    "DRAFT",
    "IN_TRANSIT",
    "RECEIVED",
    "CANCELLED",
  ];
  const orderIds = soldOrders.map((o) => o.id);

  for (let i = 0; i < 16; i++) {
    const status = transferStates[i % transferStates.length];
    const product = pick(oRng, products);
    const from = stores[i % stores.length];
    const to = stores[(i + 1) % stores.length];
    // Half the transfers exist because somebody bought something. That link is
    // what separates "move stock for a customer" from "rebalance the floor",
    // and reports read them differently.
    const forOrder = i % 2 === 0 && orderIds.length > 0;
    const raisedAt = new Date(today.getTime() - randInt(oRng, 1, 45) * 86_400_000);

    await prisma.inventoryTransfer.create({
      data: {
        productId: product.id,
        quantity: randInt(oRng, 1, 3),
        fromLocation: from.code,
        toLocation: to.code,
        fromLocationId: from.id,
        toLocationId: to.id,
        fromStockLocationId: from.backStockLocationId,
        toStockLocationId: to.floorStockLocationId,
        salesOrderId: forOrder ? pick(oRng, orderIds) : null,
        requestedByUserId: actorUserId,
        status,
        shippedAt: status === "DRAFT" ? null : raisedAt,
        receivedAt: status === "RECEIVED" ? new Date(raisedAt.getTime() + 2 * 86_400_000) : null,
        receivedByUserId: status === "RECEIVED" ? actorUserId : null,
        notes: forOrder ? "Raised to fulfil a customer order." : null,
      },
    });
    result.transfersCreated += 1;
    if (status === "IN_TRANSIT") result.inTransitTransfers += 1;
    if (forOrder) result.orderLinkedTransfers += 1;
  }

  // ---- freezes, and the counts taken against them ------------------------
  const freezePlans: { status: InventoryFreezeStatus; daysAgo: number; description: string }[] = [
    { status: "COMPLETED", daysAgo: 120, description: "Half-year physical count" },
    { status: "IN_PROGRESS", daysAgo: 2, description: "Warehouse spot count" },
  ];

  for (const plan of freezePlans) {
    const freezeDate = new Date(today.getTime() - plan.daysAgo * 86_400_000);
    const items = products.slice(0, 18);
    const freeze = await prisma.inventoryFreeze.create({
      data: {
        freezeDate,
        description: plan.description,
        status: plan.status,
        totalItems: items.length,
        totalUnits: items.length * 2,
        createdBy: SEED_ACTOR,
      },
    });
    result.freezesCreated += 1;

    for (const product of items) {
      await prisma.inventoryFreezeItem.create({
        data: {
          freezeId: freeze.id,
          productId: product.id,
          storeLocationId: pick(oRng, stores).id,
          quantity: randInt(oRng, 0, 4),
        },
      });
      result.freezeItemsCreated += 1;
    }
  }

  // ---- what the counters actually recorded -------------------------------
  for (const product of products.slice(0, 30)) {
    await prisma.physicalInventoryCount.create({
      data: {
        productId: product.id,
        stockLocation: pick(oRng, stores).code,
        quantity: randInt(oRng, 0, 5),
        countedAt: new Date(today.getTime() - randInt(oRng, 1, 10) * 86_400_000),
        userId: actorUserId,
      },
    });
    result.countsCreated += 1;
  }

  // Things nobody could identify. Some reconciled to a product afterwards,
  // some still pending -- the pending ones are the whole reason the screen
  // exists.
  for (let i = 0; i < 6; i++) {
    const reconciled = i % 3 !== 0;
    const countedAt = new Date(today.getTime() - randInt(oRng, 1, 14) * 86_400_000);
    await prisma.unidentifiedScan.create({
      data: {
        imageUrl: `/uploads/scans/unidentified-${i + 1}.jpg`,
        location: pick(oRng, SCAN_LOCATIONS),
        notes: "Tag unreadable; photographed for identification.",
        countedAt,
        countedByUserId: actorUserId,
        reconciliationStatus: reconciled ? "RECONCILED" : "PENDING",
        reconciledProductId: reconciled ? pick(oRng, products).id : null,
        reconciledAt: reconciled ? new Date(countedAt.getTime() + 86_400_000) : null,
      },
    });
    result.unidentifiedScans += 1;
  }

  // ---- the historical series inventory-value reports read ----------------
  // Month ends going back a year. One snapshot is a number; a series is the
  // trend the report is actually about.
  const snapshotProducts = products.slice(0, 25);
  for (let monthsAgo = 12; monthsAgo >= 1; monthsAgo--) {
    const snapshotDate = new Date(today);
    snapshotDate.setUTCMonth(snapshotDate.getUTCMonth() - monthsAgo);
    snapshotDate.setUTCDate(1);
    snapshotDate.setUTCHours(0, 0, 0, 0);

    for (const product of snapshotProducts) {
      await prisma.inventorySnapshot.create({
        data: {
          productId: product.id,
          storeLocationId: stores[0].id,
          stockLocationId: stores[0].backStockLocationId,
          quantity: randInt(oRng, 0, 6),
          snapshotDate,
          // Older months came from the previous system's export; recent ones
          // were taken here. Both sources are real deployments.
          source: monthsAgo > 6 ? "IMPORT" : "LOCAL",
        },
      });
      result.snapshotsCreated += 1;
    }
  }

  return result;
}
