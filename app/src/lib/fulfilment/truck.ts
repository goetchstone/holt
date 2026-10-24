// /app/src/lib/fulfilment/truck.ts
//
// A delivery run's truck is a place (DECISIONS #25).
//
// Before this, loaded units stayed at the loading bay on the books until they
// were delivered, so a stop that could not be done left its units reading as
// at the bay while they were on the truck. Now:
//
//   - loading a run (pick.ts loadRun on a handheld, or the desk moving the run
//     to LOADED in runs.ts) moves every unit staged for its orders from the
//     loading bay onto the run's truck, still each order's;
//   - a delivery takes units off the truck first (handover.ts);
//   - a stop that could not be done leaves them aboard (stops.ts failStop);
//   - back at the site, the truck is unloaded to a loading bay (unloadRun),
//     where the units wait, already pulled, for the order's next run;
//   - a run is not completed while anything is still aboard (runs.ts), and its
//     truck places are retired when it is.
//
// The place is the run's, not the vehicle's. A vehicle carries one load at a
// time, but its runs overlap on the books -- tomorrow's run can be loaded
// before today's is closed -- and a place per vehicle would mix them. With a
// place per run, a run's load, what is still aboard at the end and what to
// unload are each simply the stock at the run's own places.
//
// A place belongs to one store, so a run has one truck place per store it
// loads at: a TRANSIT place (owned, not for sale) whose deliveryRunId names the
// run. Holt makes it the first time the run loads there. Nobody sets one up,
// so Warehouse > Locations, the landing places and the stock-locations preset
// leave these places out.

import type { Prisma } from "@prisma/client";
import { lockProducts, placeOf, postMovement, type PrismaTx } from "@/lib/inventory/ledger";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import { runOrderIds } from "./pullList";

type Tx = Prisma.TransactionClient;

export class TruckError extends Error {}

/**
 * Advisory-lock space for making a run's truck place, apart from the stock
 * and place-setup spaces, so two loads of one run racing make one place.
 */
const TRUCK_LOCK_SPACE = 5_461_072;

/** The run's truck at a store, made the first time the run loads there. */
async function truckPlaceId(
  tx: Tx,
  run: { id: number; runNumber: string; vehicle: { name: string } },
  storeLocationId: number,
): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TRUCK_LOCK_SPACE}::int, ${run.id}::int)`;
  const existing = await tx.stockLocation.findFirst({
    where: { deliveryRunId: run.id, storeLocationId },
    select: { id: true },
  });
  if (existing) return existing.id;
  const place = await tx.stockLocation.create({
    data: {
      storeLocationId,
      deliveryRunId: run.id,
      code: `TRUCK-${run.runNumber}`,
      name: `${run.vehicle.name} (${run.runNumber})`,
      locationType: "TRANSIT",
      createdBy: "system",
    },
    select: { id: true },
  });
  return place.id;
}

/**
 * Put what is staged for the run on its truck: every unit its orders hold at a
 * loading bay moves aboard, still the order's. Runs every time the run is
 * loaded, so a second call moves only what was staged since.
 */
export async function boardRun(
  tx: Tx,
  deliveryRunId: number,
  args: { actor: string | null; actionKey?: string | null },
): Promise<{ units: number }> {
  const orders = await runOrderIds(tx, deliveryRunId);
  if (orders.length === 0) return { units: 0 };
  const stagedWhere: Prisma.InventoryPositionWhereInput = {
    salesOrderId: { in: orders },
    stockLocation: { locationType: "STAGING" },
  };
  const products = await tx.inventoryPosition.findMany({
    where: stagedWhere,
    distinct: ["productId"],
    select: { productId: true },
  });
  if (products.length === 0) return { units: 0 };
  await lockProducts(
    tx,
    products.map((p) => p.productId),
  );
  // Read again under the locks: a pick or a move may have changed it since.
  const staged = await tx.inventoryPosition.findMany({
    where: stagedWhere,
    orderBy: { id: "asc" },
  });

  const run = await tx.deliveryRun.findUniqueOrThrow({
    where: { id: deliveryRunId },
    select: { id: true, runNumber: true, vehicle: { select: { name: true } } },
  });
  const truckAt = new Map<number, number>();
  let units = 0;
  for (const row of staged) {
    let truck = truckAt.get(row.storeLocationId);
    if (truck == null) {
      truck = await truckPlaceId(tx, run, row.storeLocationId);
      truckAt.set(row.storeLocationId, truck);
    }
    const quantity = toQty(row.quantity);
    await postMovement(tx, {
      productId: row.productId,
      quantity,
      from: placeOf(row),
      to: {
        storeLocationId: row.storeLocationId,
        stockLocationId: truck,
        salesOrderId: row.salesOrderId,
      },
      reason: "TRANSFER",
      source: { type: "DeliveryRun", id: deliveryRunId },
      actor: args.actor,
      actionKey: args.actionKey,
    });
    units = roundQty(units + quantity);
  }
  return { units };
}

export interface AboardRow {
  storeLocationId: number;
  stockLocationId: number;
  salesOrderId: number | null;
  orderno: string | null;
  productId: number;
  productName: string;
  quantity: number;
}

/** What is on the run's truck now, at every store it loaded at. */
export async function aboard(db: PrismaTx, deliveryRunId: number): Promise<AboardRow[]> {
  const rows = await db.inventoryPosition.findMany({
    where: { stockLocation: { deliveryRunId } },
    orderBy: { id: "asc" },
    select: {
      storeLocationId: true,
      stockLocationId: true,
      salesOrderId: true,
      productId: true,
      quantity: true,
      product: { select: { name: true } },
      salesOrder: { select: { orderno: true } },
    },
  });
  return rows.map((r) => ({
    storeLocationId: r.storeLocationId,
    stockLocationId: r.stockLocationId,
    salesOrderId: r.salesOrderId,
    orderno: r.salesOrder?.orderno ?? null,
    productId: r.productId,
    productName: r.product.name,
    quantity: toQty(r.quantity),
  }));
}

/** "2 × Lamp for SO-1, 1 × Sofa for SO-2", the first few, for a message. */
export function describeAboard(rows: AboardRow[], max = 4): string {
  const shown = rows
    .slice(0, max)
    .map((r) => `${r.quantity} × ${r.productName}${r.orderno ? ` for ${r.orderno}` : ""}`);
  const more = rows.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

/**
 * Back at the site: everything on the run's truck at this loading bay's store
 * moves to the bay, still each order's, so a delivery that could not be done
 * waits there, already pulled, for the order's next run.
 */
export async function unloadRun(
  tx: Tx,
  args: {
    deliveryRunId: number;
    toStockLocationId: number;
    actor: string | null;
    actionKey?: string | null;
  },
): Promise<{ units: number }> {
  const bay = await tx.stockLocation.findUnique({
    where: { id: args.toStockLocationId },
    select: { locationType: true, storeLocationId: true },
  });
  if (!bay || bay.locationType !== "STAGING") {
    throw new TruckError("Unload to a staging place (a loading bay): scan one first.");
  }
  const onTruck: Prisma.InventoryPositionWhereInput = {
    stockLocation: { deliveryRunId: args.deliveryRunId },
  };
  const products = await tx.inventoryPosition.findMany({
    where: onTruck,
    distinct: ["productId"],
    select: { productId: true },
  });
  await lockProducts(
    tx,
    products.map((p) => p.productId),
  );
  const rows = await tx.inventoryPosition.findMany({ where: onTruck, orderBy: { id: "asc" } });
  if (rows.length === 0) throw new TruckError("Nothing is on this run's truck.");
  const here = rows.filter((r) => r.storeLocationId === bay.storeLocationId);
  if (here.length === 0) {
    throw new TruckError(
      "What is on this truck was loaded at another store: unload it at a loading bay there.",
    );
  }

  let units = 0;
  for (const row of here) {
    const quantity = toQty(row.quantity);
    await postMovement(tx, {
      productId: row.productId,
      quantity,
      from: placeOf(row),
      to: {
        storeLocationId: row.storeLocationId,
        stockLocationId: args.toStockLocationId,
        salesOrderId: row.salesOrderId,
      },
      reason: "TRANSFER",
      source: { type: "DeliveryRun", id: args.deliveryRunId },
      actor: args.actor,
      actionKey: args.actionKey,
    });
    units = roundQty(units + quantity);
  }
  return { units };
}

/**
 * The places a person sets up: every place but a run's truck. For the lists
 * people choose places from and the preset export, which must not offer one.
 */
export const NOT_A_RUN_TRUCK = { deliveryRunId: null } satisfies Prisma.StockLocationWhereInput;

/** A completed run's truck places leave service; their journal stays. */
export async function retireTruckPlaces(tx: Tx, deliveryRunId: number): Promise<void> {
  await tx.stockLocation.updateMany({
    where: { deliveryRunId },
    data: { isActive: false, updatedBy: "system" },
  });
}
