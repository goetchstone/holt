// /app/src/lib/purchasing/stockPurchaseOrder.ts
//
// GAP-01: stock purchase orders a buyer writes by hand -- create, change and
// duplicate. One function per act, called by its route; the checks they share
// (each line a product the PO's vendor sells us, buyingTerms -- its own, or one
// it is listed on as another vendor, GAP-22; a line raised for a customer's
// order keeping its product and quantity) live once, in resolvePoLines. A
// reorder scanned on the handheld (scannedOrder.ts, GAP-19) goes through it too.
//
// Cost follows "View cost" (lib/auth/costVisibility.ts): strip, never deny. A
// buyer who can't see cost still writes POs; a new line takes the product's
// cost from the catalog, and a line already on the PO keeps its own.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createNumberedPurchaseOrder } from "@/lib/purchasing/poNumber";
import { expectedArrival } from "@/lib/vendorLeadTime";
import { buyingTerms, type BuyingTerms } from "@/lib/purchasing/productSourcesShared";
import { dropShipTarget } from "@/lib/purchasing/dropShip";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import {
  poEditProblem,
  type NewPoInput,
  type PoDraftInput,
  type PoLineInput,
} from "@/lib/purchasing/purchaseOrderShared";

export class PurchaseOrderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "PurchaseOrderError";
  }
}

type Db = Pick<PrismaClient, "product" | "vendor" | "storeLocation" | "purchaseOrder">;

/** A line already on the PO, as resolvePoLines needs it. */
interface ExistingLine {
  id: number;
  productId: number | null;
  orderedQuantity: number;
  unitCost: number;
  orderLineItemId: number | null;
}

/** A line ready to write. */
export interface ResolvedLine {
  id?: number;
  productId: number;
  partNo: string;
  productName: string;
  orderedQuantity: number;
  unitCost: number;
}

/**
 * What a line costs: the cost sent, from someone who can see cost; else the
 * line's own, while it orders the same product; else the catalog's.
 */
function lineCost(
  line: PoLineInput,
  before: ExistingLine | undefined,
  catalogCost: number,
  canSetCost: boolean,
): number {
  if (canSetCost && line.unitCost != null) return line.unitCost;
  if (before && before.productId === line.productId) return before.unitCost;
  return catalogCost;
}

/** What buyingTerms reads of a product's other vendors. */
export const SOURCE_TERMS = { vendorId: true, itemNumber: true, cost: true } as const;

/** buyingTerms over a product read with its own cost and SOURCE_TERMS. */
export function termsFrom(
  product: {
    vendorId: number;
    productNumber: string;
    baseCost: Prisma.Decimal | null;
    sources: { vendorId: number; itemNumber: string | null; cost: Prisma.Decimal | null }[];
  },
  vendorId: number,
): BuyingTerms | null {
  const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));
  return buyingTerms(
    { ...product, baseCost: num(product.baseCost) },
    product.sources.map((s) => ({ ...s, cost: num(s.cost) })),
    vendorId,
  );
}

/** Each line checked against the catalog and the PO's own lines, its cost decided. */
export async function resolvePoLines(
  db: Db,
  vendor: { id: number; name: string },
  lines: readonly PoLineInput[],
  existing: readonly ExistingLine[],
  canSetCost: boolean,
): Promise<ResolvedLine[]> {
  const products = new Map(
    (
      await db.product.findMany({
        where: { id: { in: [...new Set(lines.map((l) => l.productId))] } },
        select: {
          id: true,
          productNumber: true,
          name: true,
          vendorId: true,
          baseCost: true,
          sources: { where: { vendorId: vendor.id }, select: SOURCE_TERMS },
        },
      })
    ).map((p) => [p.id, p]),
  );
  const onPo = new Map(existing.map((l) => [l.id, l]));
  const kept = new Set(lines.flatMap((l) => (l.id === undefined ? [] : [l.id])));
  const dropped = existing.find((l) => l.orderLineItemId !== null && !kept.has(l.id));
  if (dropped) {
    throw new PurchaseOrderError("A line raised for a customer's order can't be removed.");
  }

  return lines.map((line, i) => {
    const n = i + 1;
    const product = products.get(line.productId);
    if (!product) throw new PurchaseOrderError(`Line ${n}: that product doesn't exist.`);
    const terms = termsFrom(product, vendor.id);
    if (!terms) {
      throw new PurchaseOrderError(
        `Line ${n}: ${vendor.name} doesn't sell us ${product.name}. Make it the product's vendor, or add it under the product's other vendors, first.`,
      );
    }
    const before = line.id === undefined ? undefined : onPo.get(line.id);
    if (line.id !== undefined && !before) {
      throw new PurchaseOrderError(`Line ${n}: not a line on this PO.`);
    }
    if (
      before?.orderLineItemId != null &&
      (before.productId !== line.productId || before.orderedQuantity !== line.quantity)
    ) {
      throw new PurchaseOrderError(
        `Line ${n}: a line raised for a customer's order keeps its product and quantity.`,
      );
    }
    return {
      ...(before ? { id: before.id } : {}),
      productId: product.id,
      partNo: terms.partNo,
      productName: product.name,
      orderedQuantity: line.quantity,
      unitCost: lineCost(line, before, terms.cost ?? 0, canSetCost),
    };
  });
}

export async function activeShipTo(db: Db, id: number): Promise<void> {
  const store = await db.storeLocation.findUnique({ where: { id }, select: { isActive: true } });
  if (!store?.isActive) {
    throw new PurchaseOrderError("Choose an open store or warehouse for the vendor to deliver to.");
  }
}

const asDate = (ymd: string | null): Date | null => (ymd ? new Date(`${ymd}T00:00:00Z`) : null);

export const lineData = (l: ResolvedLine) => ({
  productId: l.productId,
  partNo: l.partNo,
  productName: l.productName,
  orderedQuantity: l.orderedQuantity,
  unitCost: l.unitCost,
});

/** A new stock PO, as a draft. */
export async function createStockPurchaseOrder(
  input: NewPoInput,
  ctx: { actor: string | null; canSetCost: boolean },
): Promise<{ id: number; poNumber: string }> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: input.vendorId },
    select: { id: true, name: true },
  });
  if (!vendor) throw new PurchaseOrderError("That vendor doesn't exist.");
  await activeShipTo(prisma, input.shipToLocationId);
  const lines = await resolvePoLines(prisma, vendor, input.lines, [], ctx.canSetCost);
  return createNumberedPurchaseOrder(prisma, {
    vendorId: vendor.id,
    shipToLocationId: input.shipToLocationId,
    status: "DRAFT",
    expectedDelivery: asDate(input.expectedDelivery),
    notes: input.notes,
    createdBy: ctx.actor,
    lineItems: { create: lines.map(lineData) },
  });
}

/**
 * Change a PO's ship-to, expected date, notes and lines, until anything is
 * received against it. The lines sent are the PO's lines: one left out is
 * removed.
 */
export async function editPurchaseOrder(
  poId: number,
  input: PoDraftInput,
  ctx: { actor: string | null; canSetCost: boolean },
): Promise<void> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      status: true,
      isReturn: true,
      salesOrderId: true,
      dropShipAddressId: true,
      vendor: { select: { id: true, name: true } },
      _count: { select: { receivingRecords: true } },
      lineItems: {
        select: {
          id: true,
          productId: true,
          orderedQuantity: true,
          unitCost: true,
          orderLineItemId: true,
          orderLineItem: { select: { salesOrderId: true } },
        },
      },
    },
  });
  if (!po) throw new PurchaseOrderError("Purchase order not found.", 404);
  const problem = poEditProblem({
    status: po.status,
    isReturn: po.isReturn,
    receivedCount: po._count.receivingRecords,
  });
  if (problem) throw new PurchaseOrderError(problem, 409);
  // Drop ship (GAP-20): the customer's address, as dropShipTarget finds it, or a store.
  let dropShipAddressId: number | null = null;
  if (input.dropShip) {
    const check = await dropShipTarget(prisma, poId);
    if (!check.ok) throw new PurchaseOrderError(check.problem, 409);
    dropShipAddressId = check.target.addressId;
  } else {
    await activeShipTo(prisma, input.shipToLocationId as number);
  }
  // The sales whose lines this PO carries: their stock changes when drop ship does.
  const sales = new Set(
    po.lineItems.flatMap((l) => (l.orderLineItem ? [l.orderLineItem.salesOrderId] : [])),
  );
  if (po.salesOrderId !== null) sales.add(po.salesOrderId);

  const existing = po.lineItems.map((l) => ({
    ...l,
    orderedQuantity: Number(l.orderedQuantity),
    unitCost: Number(l.unitCost),
  }));
  const lines = await resolvePoLines(prisma, po.vendor, input.lines, existing, ctx.canSetCost);
  const keep = new Set(lines.flatMap((l) => (l.id === undefined ? [] : [l.id])));

  await prisma.$transaction(async (tx) => {
    // Re-checked inside the write: a receipt that landed after the read above
    // means the lines are no longer ours to change.
    const received = await tx.receivingRecord.count({ where: { purchaseOrderId: poId } });
    if (received > 0) {
      throw new PurchaseOrderError(
        "This PO can't be changed: goods have been received against it.",
        409,
      );
    }
    await tx.purchaseOrderItem.deleteMany({
      where: { purchaseOrderId: poId, id: { notIn: [...keep] } },
    });
    for (const line of lines) {
      if (line.id === undefined) {
        await tx.purchaseOrderItem.create({ data: { purchaseOrderId: poId, ...lineData(line) } });
      } else {
        await tx.purchaseOrderItem.update({ where: { id: line.id }, data: lineData(line) });
      }
    }
    await tx.purchaseOrder.update({
      where: { id: poId },
      data: {
        shipToLocationId: dropShipAddressId === null ? input.shipToLocationId : null,
        dropShipAddressId,
        expectedDelivery: asDate(input.expectedDelivery),
        notes: input.notes,
        updatedBy: ctx.actor,
      },
    });
    // A drop-shipped line holds no store stock; one that stops being drop shipped
    // takes its place in line again (lib/inventory/orderInventorySync.ts).
    if ((po.dropShipAddressId === null) !== (dropShipAddressId === null)) {
      for (const salesOrderId of sales) {
        const sale = await tx.salesOrder.findUniqueOrThrow({
          where: { id: salesOrderId },
          select: { storeLocation: true },
        });
        await resyncOrderAllocation(salesOrderId, sale.storeLocation, tx);
      }
    }
  });
}

/**
 * A new draft with another PO's vendor, ship-to, notes and lines, at the costs
 * it had. Only lines that could be written today come across: a line without a
 * product, a zero-quantity (cancelled) line, or a product the vendor no longer
 * supplies is left behind and named.
 */
export async function duplicatePurchaseOrder(
  poId: number,
  actor: string | null,
): Promise<{ id: number; poNumber: string; skipped: string[] }> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      isReturn: true,
      notes: true,
      shipTo: { select: { id: true, isActive: true } },
      vendor: { select: { id: true, leadTimeDays: true } },
      lineItems: {
        orderBy: { id: "asc" },
        select: {
          productId: true,
          partNo: true,
          productName: true,
          orderedQuantity: true,
          unitCost: true,
          product: {
            select: {
              productNumber: true,
              name: true,
              vendorId: true,
              baseCost: true,
              sources: { select: SOURCE_TERMS },
            },
          },
        },
      },
    },
  });
  if (!po) throw new PurchaseOrderError("Purchase order not found.", 404);
  if (po.isReturn) throw new PurchaseOrderError("A vendor return can't be duplicated.");

  const skipped: string[] = [];
  const lines = po.lineItems.flatMap((l) => {
    const label = l.product?.name ?? l.productName ?? l.partNo ?? "A line";
    if (!l.product || l.productId === null) {
      skipped.push(`${label}: not a product in the catalog`);
      return [];
    }
    if (Number(l.orderedQuantity) <= 0) return []; // a cancelled line (rule 31)
    const terms = termsFrom(l.product, po.vendor.id);
    if (!terms) {
      skipped.push(`${label}: no longer sold to us by this vendor`);
      return [];
    }
    return [
      {
        productId: l.productId,
        partNo: terms.partNo,
        productName: l.product.name,
        orderedQuantity: l.orderedQuantity,
        unitCost: l.unitCost,
      },
    ];
  });
  if (lines.length === 0) {
    throw new PurchaseOrderError("Nothing on this PO can be ordered again.");
  }
  const now = new Date();
  const created = await createNumberedPurchaseOrder(
    prisma,
    {
      vendorId: po.vendor.id,
      shipToLocationId: po.shipTo?.isActive ? po.shipTo.id : null,
      status: "DRAFT",
      orderDate: now,
      expectedDelivery: expectedArrival(now, po.vendor.leadTimeDays),
      notes: po.notes,
      createdBy: actor,
      lineItems: { create: lines },
    },
    now,
  );
  return { ...created, skipped };
}

/** A PO as its editor opens it. */
export interface PoEditorState {
  id: number;
  poNumber: string;
  vendor: { id: number; name: string };
  shipToLocationId: number | null;
  /** Drop ship (GAP-20): offered only for a vendor set to drop ship. */
  dropShip: {
    /** It ships to the customer now. */
    on: boolean;
    /** Who and where it would go, when it can. */
    offer: string | null;
    /** Why it can't, when the vendor drop ships but this PO can't. */
    problem: string | null;
  } | null;
  /** YYYY-MM-DD, or null. */
  expectedDelivery: string | null;
  notes: string | null;
  /** Why it can't be changed, or null when it can. */
  editProblem: string | null;
  lines: {
    id: number;
    productId: number | null;
    partNo: string;
    productName: string;
    quantity: number;
    /** Null when the editor's user can't see cost. */
    unitCost: number | null;
    /** Raised for a customer's order: only its cost may change. */
    linked: boolean;
  }[];
}

/** The PO for the edit page, or null when there is none. Cost only when `showCost`. */
export async function loadPoForEditor(
  poId: number,
  showCost: boolean,
): Promise<PoEditorState | null> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      id: true,
      poNumber: true,
      status: true,
      isReturn: true,
      shipToLocationId: true,
      dropShipAddressId: true,
      expectedDelivery: true,
      notes: true,
      vendor: { select: { id: true, name: true, dropShips: true } },
      _count: { select: { receivingRecords: true } },
      lineItems: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          productId: true,
          partNo: true,
          productName: true,
          orderedQuantity: true,
          unitCost: true,
          orderLineItemId: true,
          product: { select: { productNumber: true, name: true } },
        },
      },
    },
  });
  if (!po) return null;
  const check = po.vendor.dropShips ? await dropShipTarget(prisma, po.id) : null;
  return {
    id: po.id,
    poNumber: po.poNumber,
    vendor: { id: po.vendor.id, name: po.vendor.name },
    shipToLocationId: po.shipToLocationId,
    dropShip: check
      ? {
          on: po.dropShipAddressId !== null,
          offer: check.ok ? check.target.label : null,
          problem: check.ok ? null : check.problem,
        }
      : null,
    expectedDelivery: po.expectedDelivery?.toISOString().slice(0, 10) ?? null,
    notes: po.notes,
    editProblem: poEditProblem({
      status: po.status,
      isReturn: po.isReturn,
      receivedCount: po._count.receivingRecords,
    }),
    lines: po.lineItems.map((l) => ({
      id: l.id,
      productId: l.productId,
      partNo: l.product?.productNumber ?? l.partNo ?? "",
      productName: l.product?.name ?? l.productName ?? "",
      quantity: Number(l.orderedQuantity),
      unitCost: showCost ? Number(l.unitCost) : null,
      linked: l.orderLineItemId !== null,
    })),
  };
}

/** What the editor offers: every vendor, and the open stores and warehouses. */
export async function poEditorOptions(): Promise<{
  vendors: { id: number; name: string; leadTimeDays: number | null }[];
  stores: { id: number; name: string }[];
}> {
  const [vendors, stores] = await Promise.all([
    prisma.vendor.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, leadTimeDays: true },
    }),
    prisma.storeLocation.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return { vendors, stores };
}
