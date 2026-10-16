// /app/src/lib/fulfilment/pick.ts
//
// Pick, stage and load a delivery run on a handheld (ledger plan phase 19).
// The run's pull list (pullList.ts) says what is still to pull and where it
// is. Picking moves a unit the order holds from there to a STAGING place
// (the loading bay), still committed to the order, so the pull list shrinks
// by itself; the run's printed pick list is ticked off as it goes.
//
//   - A multi-box unit is picked by its box labels, and only whole: an
//     incomplete set is refused, because loading it would deliver a sofa
//     without its third box.
//   - Boxes that were sitting apart (STRAY notes) and are picked with their
//     unit are reunited: the note clears.
//   - Loading the run checks that nothing is left to pull, then marks it
//     LOADED.

import type { Prisma } from "@prisma/client";
import { lockProducts, type Place } from "@/lib/inventory/ledger";
import { quickMove } from "@/lib/inventory/transfers";
import { assembleUnits } from "@/lib/inventory/boxes";
import { clearBoxNote } from "@/lib/inventory/boxNotes";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import { isValidRunTransition } from "@/lib/deliveryService";
import { buildPullList } from "./pullList";

type Tx = Prisma.TransactionClient;

export class PickError extends Error {}

async function runOrders(tx: Tx, deliveryRunId: number): Promise<number[]> {
  const stops = await tx.deliveryStop.findMany({
    where: { deliveryRunId },
    select: { serviceAppointment: { select: { salesOrderId: true } } },
  });
  return stops.map((s) => s.serviceAppointment.salesOrderId);
}

export async function pickUnits(
  tx: Tx,
  args: {
    deliveryRunId: number;
    salesOrderId: number;
    productId: number;
    units: number;
    fromStockLocationId: number;
    toStockLocationId: number;
    boxes?: number[];
    actor: string | null;
    actionKey?: string | null;
  },
): Promise<{ picked: number; reunitedBoxes: number }> {
  if (!(args.units > 0)) throw new PickError("Pick at least one unit.");
  if (!(await runOrders(tx, args.deliveryRunId)).includes(args.salesOrderId)) {
    throw new PickError("That order is not on this run.");
  }
  const [staging, product] = await Promise.all([
    tx.stockLocation.findUnique({
      where: { id: args.toStockLocationId },
      select: { locationType: true, storeLocationId: true, name: true },
    }),
    tx.product.findUniqueOrThrow({
      where: { id: args.productId },
      select: { name: true, boxesPerUnit: true },
    }),
  ]);
  if (!staging || staging.locationType !== "STAGING") {
    throw new PickError("Picks go to a staging place (a loading bay): scan one first.");
  }
  const boxesPerUnit = Math.max(1, product.boxesPerUnit ?? 1);
  if (boxesPerUnit > 1) {
    const a = assembleUnits(boxesPerUnit, args.boxes ?? []);
    if (a.incomplete.length > 0) {
      throw new PickError(
        `${product.name} is not whole: box ${a.incomplete[0].missing.join(", ")} is missing. An incomplete set cannot be loaded.`,
      );
    }
    if (a.units !== args.units) {
      throw new PickError(`Scan every box of each ${product.name} being picked.`);
    }
  }

  await lockProducts(tx, [args.productId]);
  const held = await tx.inventoryPosition.findMany({
    where: {
      productId: args.productId,
      salesOrderId: args.salesOrderId,
      stockLocationId: args.fromStockLocationId,
    },
    orderBy: { id: "asc" },
  });
  const there = roundQty(held.reduce((s, r) => s + toQty(r.quantity), 0));
  if (there < args.units) {
    throw new PickError(`The order holds only ${there} of ${product.name} at that place.`);
  }
  let left = args.units;
  for (const row of held) {
    if (!(left > 0)) break;
    const take = Math.min(left, toQty(row.quantity));
    const from: Place = {
      storeLocationId: row.storeLocationId,
      stockLocationId: row.stockLocationId,
      salesOrderId: args.salesOrderId,
    };
    await quickMove(tx, {
      productId: args.productId,
      quantity: take,
      from,
      to: {
        storeLocationId: staging.storeLocationId,
        stockLocationId: args.toStockLocationId,
        salesOrderId: args.salesOrderId,
      },
      actor: args.actor,
      actionKey: args.actionKey,
    });
    left = roundQty(left - take);
  }

  // The printed pick list, ticked off: the run's items for this order's lines.
  const items = await tx.pickListItem.findMany({
    where: {
      productId: args.productId,
      picked: false,
      pickList: { deliveryRunId: args.deliveryRunId },
      orderLineItem: { salesOrderId: args.salesOrderId },
    },
    orderBy: { id: "asc" },
  });
  let tick = args.units;
  for (const item of items) {
    if (!(tick > 0)) break;
    await tx.pickListItem.update({
      where: { id: item.id },
      data: { picked: true, pickedAt: new Date(), toStockLocationId: args.toStockLocationId },
    });
    tick = roundQty(tick - toQty(item.quantity));
  }

  // Strays reunited: open STRAY notes for boxes picked with their unit.
  let reunitedBoxes = 0;
  if (args.boxes?.length) {
    const strays = await tx.boxNote.findMany({
      where: {
        kind: "STRAY",
        productId: args.productId,
        storeLocationId: staging.storeLocationId,
        clearedAt: null,
      },
    });
    for (const n of strays) {
      if (n.boxes.every((b) => args.boxes!.includes(b))) {
        await clearBoxNote(tx, n.id, { reason: "Picked with its unit", actor: args.actor });
        reunitedBoxes += n.boxes.length;
      }
    }
  }
  return { picked: args.units, reunitedBoxes };
}

/** Mark the run LOADED once nothing on it is left to pull. */
export async function loadRun(
  tx: Tx,
  deliveryRunId: number,
  actor: string | null,
): Promise<{ loaded: true }> {
  const run = await tx.deliveryRun.findUniqueOrThrow({
    where: { id: deliveryRunId },
    select: { status: true, runNumber: true },
  });
  if (run.status === "LOADED") return { loaded: true };
  if (!isValidRunTransition(run.status, "LOADED")) {
    throw new PickError(
      `Run ${run.runNumber} is ${run.status.toLowerCase()} and cannot be loaded.`,
    );
  }
  const { rows } = await buildPullList(tx, { deliveryRunId });
  const short = rows.filter((r) => r.fromStockLocationId == null);
  const toPull = rows.filter((r) => r.fromStockLocationId != null);
  if (short.length > 0 || toPull.length > 0) {
    throw new PickError(
      [
        toPull.length ? `${toPull.length} pick(s) are not at the loading bay yet` : null,
        short.length ? `${short.length} line(s) have no stock to pull` : null,
      ]
        .filter(Boolean)
        .join("; ") + ".",
    );
  }
  await tx.deliveryRun.update({
    where: { id: deliveryRunId },
    data: { status: "LOADED", updatedBy: actor },
  });
  return { loaded: true };
}
