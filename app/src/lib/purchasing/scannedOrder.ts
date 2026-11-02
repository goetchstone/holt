// /app/src/lib/purchasing/scannedOrder.ts
//
// GAP-19: a reorder built by scanning (/app/scan/order). The buyer scans what
// to order, and each line names the vendor it is bought from: the item's own,
// or another vendor it lists (buyingTerms, GAP-22). Saving files each vendor's
// lines on that vendor's newest open draft for the store, adding to a line
// already ordering the item, or on a new draft when there is none (owner,
// 2026-11-02; docs/DECISIONS.md 33). A PO has one vendor, so one save may
// touch several drafts.
//
// Every line goes through resolvePoLines, the checks a PO written at the desk
// gets (stockPurchaseOrder.ts). The handheld sends no cost: a new line takes
// what the item costs from that vendor, and a line already on the draft keeps
// its own.
//
// Done once per action key (withAction): a resend gets the first answer and
// adds nothing twice. A new draft is numbered inside that transaction, where
// a refused insert can't be retried, so a number taken at the same moment
// runs the whole action again, as createNumberedPurchaseOrder does for one
// insert.

import type { Prisma, PrismaClient } from "@prisma/client";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { getErrorCode } from "@/lib/errorCode";
import { roundQty } from "@/lib/inventory/quantity";
import { withAction } from "@/lib/inventory/withAction";
import { nextPoNumber } from "@/lib/purchasing/poNumber";
import { expectedArrival } from "@/lib/vendorLeadTime";
import {
  activeShipTo,
  lineData,
  PurchaseOrderError,
  resolvePoLines,
  SOURCE_TERMS,
  termsFrom,
} from "./stockPurchaseOrder";
import type { FiledPo, OrderableItem, ScannedLine } from "./purchaseOrderShared";

type Tx = Prisma.TransactionClient;

const ATTEMPTS = 5;

/**
 * Why a scanned product isn't offered for reordering: the handheld offers what
 * the desk's picker does (pages/api/purchasing/vendor-products.ts), active and
 * not discontinued.
 */
function retiredProblem(p: { name: string; isActive: boolean; isDiscontinued: boolean }) {
  if (p.isDiscontinued) return `${p.name} is discontinued, so it isn't reordered.`;
  if (!p.isActive) return `${p.name} is inactive, so it isn't reordered.`;
  return null;
}

/** The vendors a product can be ordered from, or a reason it can't be ordered. */
export async function orderableItem(
  db: Pick<PrismaClient, "product">,
  productId: number,
): Promise<OrderableItem | { problem: string }> {
  const p = await db.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      productNumber: true,
      isActive: true,
      isDiscontinued: true,
      vendorId: true,
      baseCost: true,
      vendor: { select: { name: true } },
      sources: {
        orderBy: { vendor: { name: "asc" } },
        select: { ...SOURCE_TERMS, vendor: { select: { name: true } } },
      },
    },
  });
  if (!p) return { problem: "That product doesn't exist." };
  const retired = retiredProblem(p);
  if (retired) return { problem: retired };
  const vendor = (id: number, name: string) => ({
    id,
    name,
    partNo: termsFrom(p, id)?.partNo ?? p.productNumber,
  });
  return {
    product: { id: p.id, name: p.name, productNumber: p.productNumber },
    vendors: [
      vendor(p.vendorId, p.vendor.name),
      ...p.sources.map((s) => vendor(s.vendorId, s.vendor.name)),
    ],
  };
}

/**
 * The vendor's newest draft shipping to the store that nothing has been
 * received against, locked. Read again under the lock: the desk may have sent
 * it since, and then the next newest is taken.
 */
async function openDraft(tx: Tx, vendorId: number, shipToLocationId: number) {
  const passed: number[] = [];
  for (;;) {
    const draft = await tx.purchaseOrder.findFirst({
      where: {
        vendorId,
        shipToLocationId,
        status: "DRAFT",
        isReturn: false,
        salesOrderId: null,
        receivingRecords: { none: {} },
        id: { notIn: passed },
      },
      orderBy: { id: "desc" },
      select: { id: true, poNumber: true },
    });
    if (!draft) return null;
    const still = await tx.$queryRaw<{ id: number }[]>`
      SELECT "id" FROM "PurchaseOrder"
      WHERE "id" = ${draft.id}::int AND "status" = 'DRAFT' FOR UPDATE`;
    const received = await tx.receivingRecord.count({ where: { purchaseOrderId: draft.id } });
    if (still.length > 0 && received === 0) return draft;
    passed.push(draft.id);
  }
}

/** Add to a draft: a scanned item it already orders adds to that line. Returns the lines touched. */
async function addToDraft(
  tx: Tx,
  poId: number,
  vendor: { id: number; name: string },
  lines: { productId: number; quantity: number }[],
  actor: string | null,
): Promise<number> {
  const onPo = (
    await tx.purchaseOrderItem.findMany({
      where: { purchaseOrderId: poId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        productId: true,
        orderedQuantity: true,
        unitCost: true,
        orderLineItemId: true,
      },
    })
  ).map((l) => ({
    ...l,
    orderedQuantity: Number(l.orderedQuantity),
    unitCost: Number(l.unitCost),
  }));
  const changed: typeof onPo = [];
  const input = lines.map((l) => {
    // Not a line raised for a customer's order, and not a cancelled one (rule 31).
    const line = onPo.find(
      (e) => e.productId === l.productId && e.orderLineItemId === null && e.orderedQuantity > 0,
    );
    if (!line) return { productId: l.productId, quantity: l.quantity };
    changed.push(line);
    return {
      id: line.id,
      productId: l.productId,
      quantity: roundQty(line.orderedQuantity + l.quantity),
    };
  });
  const resolved = await resolvePoLines(tx, vendor, input, changed, false);
  for (const line of resolved) {
    if (line.id === undefined) {
      await tx.purchaseOrderItem.create({ data: { purchaseOrderId: poId, ...lineData(line) } });
    } else {
      await tx.purchaseOrderItem.update({
        where: { id: line.id },
        data: { orderedQuantity: line.orderedQuantity },
      });
    }
  }
  await tx.purchaseOrder.update({ where: { id: poId }, data: { updatedBy: actor } });
  return resolved.length;
}

/** File scanned lines on each vendor's open draft for the store, or a new one. */
export async function fileScannedOrder(
  tx: Tx,
  input: { shipToLocationId: number; lines: ScannedLine[]; actor: string | null },
): Promise<FiledPo[]> {
  if (input.lines.length === 0) throw new PurchaseOrderError("Nothing was scanned.");
  await activeShipTo(tx, input.shipToLocationId);

  // One line per item per vendor: an item scanned twice orders the sum.
  const byVendor = new Map<number, Map<number, number>>();
  for (const l of input.lines) {
    const items = byVendor.get(l.vendorId) ?? new Map<number, number>();
    items.set(l.productId, roundQty((items.get(l.productId) ?? 0) + l.quantity));
    byVendor.set(l.vendorId, items);
  }
  const vendors = await tx.vendor.findMany({
    where: { id: { in: [...byVendor.keys()] } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, leadTimeDays: true },
  });
  if (vendors.length !== byVendor.size) throw new PurchaseOrderError("That vendor doesn't exist.");

  const timeZone = await getBusinessTimeZone();
  const filed: FiledPo[] = [];
  for (const vendor of vendors) {
    const lines = [...byVendor.get(vendor.id)!].map(([productId, quantity]) => ({
      productId,
      quantity,
    }));
    const draft = await openDraft(tx, vendor.id, input.shipToLocationId);
    if (draft) {
      const touched = await addToDraft(tx, draft.id, vendor, lines, input.actor);
      filed.push({ ...draft, vendor: vendor.name, lines: touched, created: false });
      continue;
    }
    const resolved = await resolvePoLines(tx, vendor, lines, [], false);
    const now = new Date();
    const po = await tx.purchaseOrder.create({
      data: {
        poNumber: await nextPoNumber(tx, now, timeZone),
        vendorId: vendor.id,
        shipToLocationId: input.shipToLocationId,
        status: "DRAFT",
        orderDate: now,
        expectedDelivery: expectedArrival(now, vendor.leadTimeDays),
        createdBy: input.actor,
        lineItems: { create: resolved.map(lineData) },
      },
      select: { id: true, poNumber: true },
    });
    filed.push({ ...po, vendor: vendor.name, lines: resolved.length, created: true });
  }
  return filed;
}

/** fileScannedOrder done once per action key, run again when a PO number was taken first. */
export async function saveScannedOrder(
  actionKey: string,
  input: { shipToLocationId: number; lines: ScannedLine[] },
  actor: string | null,
): Promise<{ result: FiledPo[]; replayed: boolean }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withAction(actionKey, { kind: "ORDER", actor }, (tx) =>
        fileScannedOrder(tx, { ...input, actor }),
      );
    } catch (err) {
      if (getErrorCode(err) !== "P2002" || attempt >= ATTEMPTS) throw err;
    }
  }
}
