// app/prisma/seed/demo/purchasing.ts
//
// PurchaseOrders + PurchaseOrderItems + ReceivingRecords against the
// catalog's real vendors, dated by each vendor's standard lead time
// (Vendor.leadTimeDays, catalog.ts VENDOR_LEAD_TIME_DAYS).
//
// What a buyer who keeps up with the paperwork has open: the stock buys still
// inside their lead time, a few running late by days or weeks, and the special
// orders customers are waiting on. Everything older has been received, short-
// closed or cancelled. Statuses used to be drawn at random whatever a PO's age,
// which left POs from eighteen months ago still "submitted" and over a year
// overdue -- not a business, a backlog nobody would run.
//
// Exactly ONE stale PO is kept on purpose: a stock buy from over a year ago
// that the vendor never shipped and nobody closed. Every real deployment has
// one, and the overdue views should be seen to find it.

import type { PrismaClient, PurchaseOrderStatus } from "@prisma/client";
import { expectedArrival } from "@/lib/vendorLeadTime";
import type { Rng } from "./rng";
import { chance, pick, randInt, round2, subRng } from "./rng";
import { UNKNOWN_VENDOR_ACTUAL_LEAD_DAYS, type CatalogProduct } from "./catalog";
import type { StoreSetup } from "./locations";
import type { SeededStaffMember } from "./staff";

const SEED_ACTOR = "seed:demo";
const DAY_MS = 86_400_000;

/** How often a vendor delivers late, and by how much. Late and still open is
 *  what makes a PO overdue on the as-of day. */
const LATE_SHARE = 0.15;
const LATE_DAYS: [number, number] = [5, 30];

/** The one forgotten PO: placed this many days before the as-of day. */
const STALE_PO_AGE_DAYS: [number, number] = [400, 430];

export interface PurchasingResult {
  /** POs raised against a customer order -- the special-order chain. */
  specialOrdersCreated: number;
  purchaseOrdersCreated: number;
  receivingRecordsCreated: number;
  /** Open POs whose expected date has passed. */
  overdueOpen: number;
}

function poNumberFor(orderDate: Date, seq: number): string {
  const yy = orderDate.getUTCFullYear().toString().slice(-2);
  const mm = (orderDate.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = orderDate.getUTCDate().toString().padStart(2, "0");
  return `PO-${yy}${mm}${dd}-${seq.toString().padStart(4, "0")}`;
}

/** Where a stock PO stands today, from when it was placed and how long the
 *  vendor takes. */
function stockPoState(
  rng: Rng,
  orderDate: Date,
  actualLeadDays: number,
  today: Date,
): { status: PurchaseOrderStatus; arrivedAt: Date | null } {
  const ageDays = (today.getTime() - orderDate.getTime()) / DAY_MS;
  const slip = chance(rng, LATE_SHARE)
    ? randInt(rng, LATE_DAYS[0], LATE_DAYS[1])
    : randInt(rng, -4, 2);
  const arrivedAt = new Date(orderDate.getTime() + (actualLeadDays + slip) * DAY_MS);

  if (arrivedAt.getTime() <= today.getTime()) {
    // Arrived. A recent arrival is sometimes short, the rest backordered; an
    // older one was either received in full or the balance short-closed.
    const recent = today.getTime() - arrivedAt.getTime() < 21 * DAY_MS;
    if (recent && chance(rng, 0.2)) return { status: "RECEIVED_PARTIAL", arrivedAt };
    const roll = rng();
    if (roll < 0.04) return { status: "CANCELLED", arrivedAt: null };
    if (roll < 0.1) return { status: "SHORT_CLOSED", arrivedAt };
    return { status: "RECEIVED_FULL", arrivedAt };
  }
  // Still coming. Freshly raised POs may not have gone out yet; a vendor
  // acknowledges within a few days.
  if (ageDays < 2 && chance(rng, 0.5)) return { status: "DRAFT", arrivedAt: null };
  if (ageDays < 6) return { status: "SUBMITTED", arrivedAt: null };
  return { status: "CONFIRMED", arrivedAt: null };
}

export async function seedPurchasing(
  prisma: PrismaClient,
  rng: Rng,
  window: { start: Date; end: Date },
  products: readonly CatalogProduct[],
  stores: readonly StoreSetup[],
  warehouseStaff: readonly SeededStaffMember[],
  purchaseOrderCount: number,
  /** Now. Every PO's state is read against it. */
  today: Date,
): Promise<PurchasingResult> {
  const poRng = subRng(rng, "purchasing");

  const productsByVendor = new Map<number, CatalogProduct[]>();
  for (const p of products) {
    const arr = productsByVendor.get(p.vendorId);
    if (arr) arr.push(p);
    else productsByVendor.set(p.vendorId, [p]);
  }
  const vendorIds = [...productsByVendor.keys()];
  const leadTimeOf = (vendorId: number) =>
    productsByVendor.get(vendorId)?.[0]?.vendorLeadTimeDays ?? null;

  const receiver = warehouseStaff[0];
  const spanMs = Math.max(0, today.getTime() - window.start.getTime());

  const result: PurchasingResult = {
    specialOrdersCreated: 0,
    purchaseOrdersCreated: 0,
    receivingRecordsCreated: 0,
    overdueOpen: 0,
  };

  // ---- STOCK BUYS ---------------------------------------------------------
  for (let i = 0; i < purchaseOrderCount; i++) {
    // The vendor with a lead time on file, for the stale PO, so its overdue
    // date is a real one rather than "No ESD".
    const isStale = i === 0;
    const vendorId = isStale
      ? (vendorIds.find((v) => leadTimeOf(v) != null) ?? vendorIds[0])
      : pick(poRng, vendorIds);
    const vendorProducts = productsByVendor.get(vendorId)!;
    const leadTimeDays = leadTimeOf(vendorId);
    const actualLead = leadTimeDays ?? UNKNOWN_VENDOR_ACTUAL_LEAD_DAYS;

    const orderDate = isStale
      ? new Date(
          today.getTime() - randInt(poRng, STALE_PO_AGE_DAYS[0], STALE_PO_AGE_DAYS[1]) * DAY_MS,
        )
      : new Date(window.start.getTime() + randInt(poRng, 0, spanMs));
    const state = isStale
      ? { status: "CONFIRMED" as const, arrivedAt: null }
      : stockPoState(poRng, orderDate, actualLead, today);
    const expected = expectedArrival(orderDate, leadTimeDays);

    const lineCount = randInt(poRng, 1, 4);
    const lines = Array.from({ length: lineCount }, () => pick(poRng, vendorProducts));

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: poNumberFor(orderDate, i + 1),
        vendorId,
        orderDate,
        // A partial's balance is re-promised by the vendor.
        expectedDelivery:
          state.status === "RECEIVED_PARTIAL"
            ? new Date(today.getTime() + randInt(poRng, 7, 21) * DAY_MS)
            : expected,
        status: state.status,
        vendorAckNumber:
          state.status === "DRAFT" || state.status === "SUBMITTED"
            ? null
            : `ACK-${randInt(poRng, 10000, 99999)}`,
        notes: isStale
          ? "Vendor never shipped and the PO was never closed."
          : state.status === "SHORT_CLOSED"
            ? "Vendor discontinued item — short-closed remaining balance."
            : state.status === "CANCELLED"
              ? "Cancelled before it shipped."
              : null,
        createdBy: SEED_ACTOR,
        lineItems: {
          create: lines.map((product) => {
            const orderedQuantity = randInt(poRng, 1, 6);
            const unitCost = round2(product.baseCost * (0.95 + poRng() * 0.1));
            return {
              productId: product.id,
              partNo: product.productNumber,
              productName: product.name,
              orderedQuantity,
              unitCost,
            };
          }),
        },
      },
      include: { lineItems: true },
    });
    result.purchaseOrdersCreated += 1;
    const isOpen = ["DRAFT", "SUBMITTED", "CONFIRMED", "RECEIVED_PARTIAL"].includes(state.status);
    if (isOpen && po.expectedDelivery && po.expectedDelivery < today) result.overdueOpen += 1;

    const received =
      state.arrivedAt &&
      (state.status === "RECEIVED_FULL" ||
        state.status === "RECEIVED_PARTIAL" ||
        state.status === "SHORT_CLOSED");
    if (received) {
      const store = pick(poRng, stores);
      for (const [n, item] of po.lineItems.entries()) {
        // A partial or short-closed PO has at least one line that came up
        // short -- its last -- or its status would contradict its receipts.
        const mustBeShort = state.status !== "RECEIVED_FULL" && n === po.lineItems.length - 1;
        const fullyReceive =
          state.status === "RECEIVED_FULL" || (!mustBeShort && chance(poRng, 0.5));
        const ordered = Number(item.orderedQuantity);
        const qty = fullyReceive ? ordered : Math.floor(ordered * (0.3 + poRng() * 0.4));
        if (qty <= 0) continue; // nothing of this line arrived
        await prisma.receivingRecord.create({
          data: {
            purchaseOrderItemId: item.id,
            purchaseOrderId: po.id,
            quantityReceived: qty,
            receivedDate: state.arrivedAt!,
            receiverUserId: receiver.userId,
            destinationLocationId: store.id,
            destinationStockLocationId: store.backStockLocationId,
            condition: chance(poRng, 0.95) ? "OK" : "Damaged",
            tagsPrinted: true,
          },
        });
        result.receivingRecordsCreated += 1;
      }
    }
  }

  // ---- SPECIAL ORDERS: a PO raised BECAUSE a customer bought something ----
  //
  // The Delivery Planner deliberately shows only POs carrying a `salesOrderId`
  // -- the ones where a named customer is waiting on a named vendor. That chain
  // is the whole furniture special-order thought process: the customer orders
  // it, the buyer raises it with the vendor, the warehouse watches it land,
  // dispatch schedules it, the driver delivers it, and only then is it a sale.
  //
  // One PO per vendor on the order, as the register raises them
  // (lib/paymentService.ts onPaymentReceived), for every order still waiting on
  // its goods (dispatchStatus PO_PLACED). Those are recent by construction
  // (orderPlan.ts planDelivery), so each PO's expected date is order date +
  // vendor lead time: mostly ahead, a few already past where a vendor is late,
  // and none for the vendor whose lead time nobody entered.
  const awaitingGoods = await prisma.salesOrder.findMany({
    where: { dispatchStatus: "PO_PLACED", deliveredAt: null },
    select: {
      id: true,
      orderno: true,
      orderDate: true,
      lineItems: {
        where: { productId: { not: null }, lineItemStatus: { not: "CANCELLED" } },
        select: { id: true, productId: true, orderedQuantity: true },
        orderBy: { lineNumber: "asc" },
      },
    },
    orderBy: { orderDate: "desc" },
  });

  const productById = new Map(products.map((p) => [p.id, p]));
  for (const order of awaitingGoods) {
    const orderDate = new Date(order.orderDate ?? today);
    const byVendor = new Map<number, typeof order.lineItems>();
    for (const li of order.lineItems) {
      const product = productById.get(li.productId!);
      if (!product) continue;
      const arr = byVendor.get(product.vendorId);
      if (arr) arr.push(li);
      else byVendor.set(product.vendorId, [li]);
    }

    // The order waits on its slowest vendor (orderPlan.ts planDelivery). A
    // faster vendor's goods have usually landed already and sit in the
    // warehouse until the rest arrive: that PO is received, not overdue.
    const actualLead = (vendorId: number) =>
      leadTimeOf(vendorId) ?? UNKNOWN_VENDOR_ACTUAL_LEAD_DAYS;
    const slowest = Math.max(...[...byVendor.keys()].map(actualLead));

    let seq = 0;
    for (const [vendorId, lines] of byVendor) {
      seq += 1;
      const expected = expectedArrival(orderDate, leadTimeOf(vendorId));
      const ageDays = (today.getTime() - orderDate.getTime()) / DAY_MS;
      const landedAt = new Date(orderDate.getTime() + actualLead(vendorId) * DAY_MS);
      const alreadyHere = actualLead(vendorId) < slowest && landedAt.getTime() <= today.getTime();
      const status: PurchaseOrderStatus = alreadyHere
        ? "RECEIVED_FULL"
        : ageDays < 1
          ? "DRAFT"
          : ageDays < 5
            ? "SUBMITTED"
            : "CONFIRMED";

      const special = await prisma.purchaseOrder.create({
        data: {
          poNumber: `PO-SO-${order.orderno.replace(/[^0-9]/g, "").slice(-6)}-${seq}`,
          vendorId,
          salesOrderId: order.id,
          orderDate,
          expectedDelivery: expected,
          estimatedShipDate: status === "CONFIRMED" || alreadyHere ? expected : null,
          status,
          vendorAckNumber:
            status === "CONFIRMED" || alreadyHere ? `ACK-${randInt(poRng, 10000, 99999)}` : null,
          notes: "Special order — customer waiting.",
          createdBy: SEED_ACTOR,
          lineItems: {
            create: lines.map((li) => {
              const p = productById.get(li.productId!);
              return {
                productId: li.productId!,
                orderLineItemId: li.id,
                partNo: p?.productNumber ?? null,
                productName: p?.name ?? null,
                orderedQuantity: Number(li.orderedQuantity ?? 1),
                unitCost: round2((p?.baseCost ?? 0) * (0.95 + poRng() * 0.1)),
              };
            }),
          },
        },
        include: { lineItems: true },
      });
      result.purchaseOrdersCreated += 1;
      result.specialOrdersCreated += 1;
      if (alreadyHere) {
        const warehouse = stores[0];
        for (const item of special.lineItems) {
          await prisma.receivingRecord.create({
            data: {
              purchaseOrderItemId: item.id,
              purchaseOrderId: special.id,
              quantityReceived: Number(item.orderedQuantity),
              receivedDate: landedAt,
              receiverUserId: receiver.userId,
              destinationLocationId: warehouse.id,
              destinationStockLocationId: warehouse.backStockLocationId,
              condition: "OK",
              tagsPrinted: true,
            },
          });
          result.receivingRecordsCreated += 1;
        }
      } else if (expected && expected < today) {
        result.overdueOpen += 1;
      }
    }
  }

  return result;
}
