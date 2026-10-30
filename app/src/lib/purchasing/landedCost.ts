// /app/src/lib/purchasing/landedCost.ts
//
// GAP-02: landed cost on the books. A PO's charges (freight, duty, crating) are
// spread across its lines (lib/purchasing/landedCostShared.ts), so each line has
// a landed unit cost: its unit cost and its share of the charges per unit.
//
//   - A receipt brings its units into the product's average landed cost at
//     that landed unit cost, and remembers it (ReceivingRecord.landedUnitCost).
//   - A charge added or removed after goods arrived re-spreads: each receipt's
//     landed unit cost moves to the new one, and the difference lands on the
//     product's average over what is on hand. With nothing on hand it has no
//     stock to land on, and the answer says how much.
//   - Taking a receipt back takes its units out of the average at the cost
//     they came in at (lib/purchasing/unreceive.ts).
//
// A line with no unit cost has no landed cost: it neither moves an average nor
// takes a share it could not carry. A line without a catalog product is not
// stock, and takes no share either.

import type { Prisma } from "@prisma/client";
import { lockProducts } from "@/lib/inventory/ledger";
import { toQty } from "@/lib/inventory/quantity";
import {
  addToAverage,
  allocateCharge,
  landedUnitCost,
  perUnitCharges,
  productCost,
  removeFromAverage,
  spreadOverStock,
  unitVolume,
  type ChargeLine,
  type LandedCostSplit,
} from "@/lib/purchasing/landedCostShared";

type Tx = Prisma.TransactionClient;

export class ChargeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ChargeError";
  }
}

/** Stock value and a sale's cost in SQL: the landed cost, else the catalog cost. */
export const productCostSql = (alias: string): string =>
  `COALESCE(${alias}."landedCost", ${alias}."baseCost")`;

interface PoForCharges {
  lines: (ChargeLine & { productId: number })[];
  charges: { amount: number; splitBy: LandedCostSplit }[];
}

async function loadForCharges(tx: Tx, poId: number): Promise<PoForCharges> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      charges: { select: { amount: true, splitBy: true } },
      lineItems: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          orderedQuantity: true,
          unitCost: true,
          productId: true,
          partNo: true,
          productName: true,
          product: {
            select: {
              name: true,
              cubicFeet: true,
              width: true,
              length: true,
              depth: true,
              height: true,
            },
          },
        },
      },
    },
  });
  if (!po) throw new ChargeError("Purchase order not found.", 404);
  return {
    charges: po.charges.map((c) => ({ amount: Number(c.amount), splitBy: c.splitBy })),
    lines: po.lineItems.flatMap((l) =>
      l.productId === null || !l.product
        ? []
        : [
            {
              id: l.id,
              productId: l.productId,
              quantity: toQty(l.orderedQuantity),
              unitCost: Number(l.unitCost),
              volume: unitVolume(l.product),
              label: l.product.name || l.productName || l.partNo || `Line ${l.id}`,
            },
          ],
    ),
  };
}

/** Each costed stock line's landed unit cost, by PO line id. */
export async function poLandedUnitCosts(tx: Tx, poId: number): Promise<Map<number, number>> {
  const { lines, charges } = await loadForCharges(tx, poId);
  const perUnit = perUnitCharges(charges, lines);
  return new Map(
    lines
      .filter((l) => l.unitCost > 0)
      .map((l) => [l.id, landedUnitCost(l.unitCost, perUnit.get(l.id) ?? 0)]),
  );
}

async function onHand(tx: Tx, productId: number): Promise<number> {
  const sum = await tx.inventoryPosition.aggregate({
    where: { productId },
    _sum: { quantity: true },
  });
  return toQty(sum._sum.quantity);
}

/** The product's average as stored, and the cost that stands for it until it has one. */
async function currentCost(
  tx: Tx,
  productId: number,
): Promise<{ stored: number | null; average: number | null }> {
  const product = await tx.product.findUniqueOrThrow({
    where: { id: productId },
    select: { landedCost: true, baseCost: true },
  });
  return {
    stored: product.landedCost === null ? null : Number(product.landedCost),
    average: productCost(product),
  };
}

/**
 * Store a new average. Compared with what is stored, not with the cost that
 * stood in: a first receipt at exactly the catalog cost still gives the
 * product a landed cost of its own.
 */
async function setAverage(
  tx: Tx,
  productId: number,
  before: { stored: number | null },
  after: number | null,
) {
  if (after !== null && after !== before.stored) {
    await tx.product.update({ where: { id: productId }, data: { landedCost: after } });
  }
}

/**
 * Bring a receipt into its product's average. Call before the units are posted
 * into stock, with the product locked: the average is over what was on hand.
 */
export async function averageInReceipt(
  tx: Tx,
  args: { productId: number; quantity: number; unitCost: number },
): Promise<void> {
  const before = await currentCost(tx, args.productId);
  const after = addToAverage({
    onHand: await onHand(tx, args.productId),
    average: before.average,
    quantity: args.quantity,
    unitCost: args.unitCost,
  });
  await setAverage(tx, args.productId, before, after);
}

/**
 * Take a receipt's units back out of the average, at the cost they came in at.
 * Call before the units leave stock, with the product locked.
 */
export async function averageOutReceipt(
  tx: Tx,
  args: { productId: number; quantity: number; unitCost: number },
): Promise<void> {
  const before = await currentCost(tx, args.productId);
  const after = removeFromAverage({
    onHand: await onHand(tx, args.productId),
    average: before.average,
    quantity: args.quantity,
    unitCost: args.unitCost,
  });
  await setAverage(tx, args.productId, before, after);
}

/**
 * After the PO's charges change: move each receipt to its line's landed unit
 * cost now, and land the difference on its product's average over what is on
 * hand. Returns what could not land because the product has none on hand.
 */
async function respreadReceipts(tx: Tx, poId: number): Promise<number> {
  const landed = await poLandedUnitCosts(tx, poId);
  const records = await tx.receivingRecord.findMany({
    where: { purchaseOrderId: poId, landedUnitCost: { not: null } },
    select: {
      id: true,
      purchaseOrderItemId: true,
      quantityReceived: true,
      landedUnitCost: true,
      purchaseOrderItem: { select: { productId: true } },
    },
  });
  const deltaByProduct = new Map<number, number>();
  for (const r of records) {
    const productId = r.purchaseOrderItem.productId;
    const now = landed.get(r.purchaseOrderItemId);
    if (productId === null || now === undefined) continue;
    const delta = toQty(r.quantityReceived) * (now - Number(r.landedUnitCost));
    if (Math.abs(delta) < 0.00005) continue;
    await tx.receivingRecord.update({ where: { id: r.id }, data: { landedUnitCost: now } });
    deltaByProduct.set(productId, (deltaByProduct.get(productId) ?? 0) + delta);
  }

  // The callers locked every product on the PO before reading anything.
  let unabsorbed = 0;
  for (const [productId, delta] of deltaByProduct) {
    const before = await currentCost(tx, productId);
    const spread = spreadOverStock({
      onHand: await onHand(tx, productId),
      average: before.average,
      delta,
    });
    await setAverage(tx, productId, before, spread.average);
    if (!spread.absorbed) unabsorbed += delta;
  }
  return Math.round(unabsorbed * 100) / 100;
}

async function chargeablePo(tx: Tx, poId: number): Promise<void> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: poId },
    select: { status: true, isReturn: true },
  });
  if (!po) throw new ChargeError("Purchase order not found.", 404);
  if (po.isReturn) throw new ChargeError("A vendor return takes no landed charges.", 409);
  if (po.status === "CANCELLED") {
    throw new ChargeError("A cancelled purchase order takes no landed charges.", 409);
  }
}

/** Add a charge to a PO and land it on what has arrived. */
export async function addCharge(
  tx: Tx,
  args: {
    poId: number;
    description: string;
    amount: number;
    splitBy: LandedCostSplit;
    actor: string | null;
  },
): Promise<{ id: number; unabsorbed: number }> {
  await chargeablePo(tx, args.poId);
  const { lines } = await loadForCharges(tx, args.poId);
  await lockProducts(
    tx,
    lines.map((l) => l.productId),
  );
  const fits = allocateCharge(args.amount, lines, args.splitBy);
  if (!fits.ok) throw new ChargeError(fits.problem);
  const charge = await tx.purchaseOrderCharge.create({
    data: {
      purchaseOrderId: args.poId,
      description: args.description,
      amount: args.amount,
      splitBy: args.splitBy,
      createdBy: args.actor,
    },
    select: { id: true },
  });
  return { id: charge.id, unabsorbed: await respreadReceipts(tx, args.poId) };
}

/** Remove a charge from a PO and take it back off what has arrived. */
export async function removeCharge(
  tx: Tx,
  args: { poId: number; chargeId: number },
): Promise<{ unabsorbed: number }> {
  const charge = await tx.purchaseOrderCharge.findFirst({
    where: { id: args.chargeId, purchaseOrderId: args.poId },
    select: { id: true },
  });
  if (!charge) throw new ChargeError("That charge isn't on this purchase order.", 404);
  const { lines } = await loadForCharges(tx, args.poId);
  await lockProducts(
    tx,
    lines.map((l) => l.productId),
  );
  await tx.purchaseOrderCharge.delete({ where: { id: charge.id } });
  return { unabsorbed: await respreadReceipts(tx, args.poId) };
}
