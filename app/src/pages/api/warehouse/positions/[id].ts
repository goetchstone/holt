// /app/src/pages/api/warehouse/positions/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { success, badRequest, notFound, methodNotAllowed, handleError } from "@/lib/apiResponse";
import {
  lockProducts,
  placeOf,
  placeWhere,
  postMovement,
  setPlaceQuantity,
} from "@/lib/inventory/ledger";
import type { Place } from "@/lib/inventory/ledger";
import { placeAt } from "@/lib/inventory/places";
import { requiredMoveMode } from "@/lib/inventory/moveModes";
import { MoveModeError } from "@/lib/inventory/transfers";
import { toQty } from "@/lib/inventory/quantity";

// Mutating inventory positions (quantity changes, moves, deletes) is a
// warehouse task. Outside of warehouse / manager / admin, no role has a
// legitimate workflow reason to edit a position directly.
//
// Every change goes through lib/inventory/ledger.ts, the single writer of
// InventoryPosition: an edit is a move to the new place followed by setting
// that place to the stated quantity, and a delete is the units leaving Holt's
// books. Rows for the same place are merged as they are written, so the row
// returned may carry a different id from the one edited. When the edit leaves
// the place empty there is no row to return; the response then describes the
// place with quantity 0 rather than claiming the position was never found.

/** Read a row's product, lock it, then re-read the row under the lock. */
async function lockedRow(tx: Prisma.TransactionClient, id: number) {
  const seen = await tx.inventoryPosition.findUnique({
    where: { id },
    select: { productId: true },
  });
  if (!seen) return null;
  await lockProducts(tx, [seen.productId]);
  return tx.inventoryPosition.findUnique({ where: { id } });
}

/** The place's current row, or an explicit empty place when nothing is left. */
async function placeState(tx: Prisma.TransactionClient, productId: number, place: Place) {
  const row = await tx.inventoryPosition.findFirst({
    where: placeWhere(productId, place),
    orderBy: { id: "asc" },
  });
  return row ?? { productId, ...place, quantity: 0 };
}

export const handler = async (req: NextApiRequest, res: NextApiResponse, session: unknown) => {
  const positionId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(positionId)) return badRequest(res, "Invalid position ID");
  const actor = (session as { user?: { email?: string | null } } | null)?.user?.email || null;

  if (req.method === "PUT") {
    try {
      const { quantity, stockLocationId, storeLocationId, salesOrderId, notes } = req.body;
      if (quantity !== undefined && !(Number(quantity) >= 0)) {
        return badRequest(res, "quantity must be zero or more.");
      }

      const result = await prisma.$transaction(async (tx) => {
        const row = await lockedRow(tx, positionId);
        if (!row) return null;

        const from = placeOf(row);
        // A new store with no place named, or a place cleared to null, means
        // that store's receiving place: a place in the old store cannot follow
        // the units to a new one.
        const toStore = storeLocationId ?? row.storeLocationId;
        const keepPlace = stockLocationId === undefined && toStore === row.storeLocationId;
        const to: Place = await placeAt(tx, {
          storeLocationId: toStore,
          stockLocationId: keepPlace ? from.stockLocationId : stockLocationId,
          salesOrderId: salesOrderId === undefined ? from.salesOrderId : (salesOrderId ?? null),
        });

        const units = toQty(row.quantity);
        // Moving units to another place by hand is a quick move, allowed only
        // where the two places' move mode says so (between stores it is a
        // tracked transfer by default).
        if (
          to.stockLocationId !== from.stockLocationId &&
          (await requiredMoveMode(tx, from.stockLocationId, to.stockLocationId)) !== "QUICK"
        ) {
          throw new MoveModeError();
        }
        const moved =
          to.storeLocationId !== from.storeLocationId ||
          to.stockLocationId !== from.stockLocationId ||
          to.salesOrderId !== from.salesOrderId;
        if (moved) {
          await postMovement(tx, {
            productId: row.productId,
            quantity: units,
            from,
            to,
            reason: "TRANSFER",
            actor,
          });
        }

        // The stated quantity is what this row's units should now be. Other
        // rows already at the destination keep theirs, so the place's target
        // is its current total plus the change to this row.
        if (quantity !== undefined || notes !== undefined) {
          const agg = await tx.inventoryPosition.aggregate({
            where: placeWhere(row.productId, to),
            _sum: { quantity: true },
          });
          const current = toQty(agg._sum.quantity);
          const target = quantity === undefined ? current : current - units + Number(quantity);
          await setPlaceQuantity(tx, {
            productId: row.productId,
            place: to,
            target: Math.max(0, target),
            reason: "ADJUST",
            actor,
            note: notes === undefined ? undefined : (notes ?? null),
          });
        }

        return placeState(tx, row.productId, to);
      });

      if (result === null) return notFound(res, "Position");
      return success(res, { ...result, quantity: toQty(result.quantity) });
    } catch (err) {
      if (err instanceof MoveModeError) return res.status(409).json({ error: err.message });
      return handleError(res, err, "PUT /warehouse/positions/[id]");
    }
  }

  if (req.method === "DELETE") {
    try {
      const found = await prisma.$transaction(async (tx) => {
        const row = await lockedRow(tx, positionId);
        if (!row) return false;
        // Deleting a position is its units leaving Holt's books by hand.
        await postMovement(tx, {
          productId: row.productId,
          quantity: toQty(row.quantity),
          from: placeOf(row),
          reason: "ADJUST",
          actor,
        });
        return true;
      });
      if (!found) return notFound(res, "Position");
      return success(res, { success: true });
    } catch (err) {
      return handleError(res, err, "DELETE /warehouse/positions/[id]");
    }
  }

  return methodNotAllowed(res, ["PUT", "DELETE"]);
};

export default requirePermission("inventory.transfer", handler);
