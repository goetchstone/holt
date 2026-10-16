// /app/src/pages/api/warehouse/transfers/[id]/status.ts
//
// Advances transfer status and moves the stock, in one transaction, through
// lib/inventory/ledger.ts (the single writer of InventoryPosition).
// DRAFT -> IN_TRANSIT: takes the units from free stock at the source, or refuses
//                      (409) if the source does not hold enough
// IN_TRANSIT -> RECEIVED: adds the units shipped to the destination
// IN_TRANSIT -> CANCELLED: puts the units shipped back at the source

import { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { allocate, freePositionWhere } from "@/lib/inventory/allocation";
import { drawLegs, postMovement } from "@/lib/inventory/ledger";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { toQty, roundQty } from "@/lib/inventory/quantity";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

/** Another request changed this transfer's status first. */
class TransferRaceError extends Error {}

/** The source holds less free stock than the transfer asks to ship. */
class TransferShortError extends Error {
  constructor(
    readonly available: number,
    readonly requested: number,
    readonly source: string,
  ) {
    super("Not enough free stock at the source to ship this transfer.");
  }
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["RECEIVED", "CANCELLED"],
};

// Advancing transfer status moves inventory between stores. Warehouse staff
// and their managers only.
export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "PUT") return res.status(405).json({ error: "Method not allowed" });

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Transfer ID is required." });
  }

  const transferId = Number.parseInt(id);
  const { status: newStatus } = req.body;

  if (!newStatus) {
    return res.status(400).json({ error: "New status is required." });
  }

  try {
    const transfer = await prisma.inventoryTransfer.findUnique({
      where: { id: transferId },
    });

    if (!transfer) return res.status(404).json({ error: "Transfer not found." });

    const allowed = VALID_TRANSITIONS[transfer.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return res.status(400).json({
        error: `Cannot transition from ${transfer.status} to ${newStatus}.`,
      });
    }

    if (!transfer.fromLocationId || !transfer.toLocationId) {
      return res.status(400).json({
        error: "Transfer must have from and to location IDs for status changes.",
      });
    }

    await prisma.$transaction(async (tx) => {
      const quantity = toQty(transfer.quantity);
      const actor = session.user!.email;

      // Claim the transition before moving any stock: only the request that
      // finds the transfer still in the status it read may proceed. Without
      // this, a double-clicked "Ship" ran twice and took the units twice --
      // the status check above happens outside this transaction.
      const claimed = await tx.inventoryTransfer.updateMany({
        where: { id: transferId, status: transfer.status },
        data: { status: newStatus },
      });
      if (claimed.count === 0) throw new TransferRaceError();

      if (newStatus === "IN_TRANSIT") {
        // Take the units from the source. A stock location the user chose is
        // taken at its word: its uncommitted units go, whether or not the
        // location is flagged as holding customers' stock (moving that stock
        // between stores is a real task). With none chosen ("any"), only
        // genuinely free stock at that store will do.
        //
        // This used to look for a free row with exactly the chosen stock
        // location -- null for "any" -- and, finding none, do nothing at all.
        // Imported stock always carries a stock location, so "any" never found
        // it: the source kept its units and RECEIVED then created them again at
        // the destination. Stock appeared from nowhere on the ordinary path.
        // Now the source either gives up the units or the ship is refused.
        const sourceWhere: Prisma.InventoryPositionWhereInput =
          transfer.fromStockLocationId == null
            ? { AND: [freePositionWhere(), { storeLocationId: transfer.fromLocationId! }] }
            : {
                storeLocationId: transfer.fromLocationId!,
                stockLocationId: transfer.fromStockLocationId,
                salesOrderId: null,
              };
        const { legs, shortfall } = await drawLegs(tx, {
          productId: transfer.productId,
          where: sourceWhere,
          quantity,
        });
        if (shortfall > 0) {
          throw new TransferShortError(
            roundQty(quantity - shortfall),
            quantity,
            transfer.fromLocation,
          );
        }
        for (const leg of legs) {
          await postMovement(tx, {
            productId: transfer.productId,
            quantity: leg.take,
            from: leg.place,
            actor,
          });
        }

        await tx.inventoryTransfer.update({
          where: { id: transferId },
          data: { status: "IN_TRANSIT", shippedAt: new Date() },
        });
      } else if (newStatus === "RECEIVED") {
        // The units shipped arrive at the destination as free stock. Through
        // the single writer, which merges into the existing row (rule 64).
        await postMovement(tx, {
          productId: transfer.productId,
          quantity,
          to: {
            storeLocationId: transfer.toLocationId!,
            stockLocationId: transfer.toStockLocationId ?? null,
            salesOrderId: null,
          },
          actor,
        });

        // The stock has landed at the destination store, so an order that was
        // waiting on it can finally hold it. Allocation is store-scoped, which
        // is the whole reason the transfer existed.
        //
        // Best-effort on purpose: the goods HAVE physically arrived, and a
        // receipt must not fail because the order was cancelled or already
        // filled from elsewhere while the stock was in transit. The transfer is
        // recorded either way and the order simply stays short, which the
        // shortfall queue already surfaces.
        if (transfer.salesOrderId) {
          try {
            await allocate(
              transfer.salesOrderId,
              [
                {
                  productId: transfer.productId,
                  storeLocationId: transfer.toLocationId!,
                  quantity: toQty(transfer.quantity),
                },
              ],
              tx,
            );
          } catch (err) {
            logError("Transfer received but allocating to its order failed", err, {
              transferId,
              salesOrderId: transfer.salesOrderId,
            });
          }
        }

        await tx.inventoryTransfer.update({
          where: { id: transferId },
          data: {
            status: "RECEIVED",
            receivedAt: new Date(),
            receivedByUserId: session.user!.email,
          },
        });
      } else if (newStatus === "CANCELLED") {
        // Put the shipped units back at the source. Through the single writer:
        // the upsert this replaced could never match a free row (rule 64), so
        // every cancel created another duplicate. When the ship drew from
        // several stock locations ("any"), they come back to the store with no
        // stock location; returning each to the exact place it left needs the
        // movement journal (plan phase 6).
        if (transfer.status === "IN_TRANSIT") {
          await postMovement(tx, {
            productId: transfer.productId,
            quantity,
            to: {
              storeLocationId: transfer.fromLocationId!,
              stockLocationId: transfer.fromStockLocationId ?? null,
              salesOrderId: null,
            },
            actor,
          });
        }

        await tx.inventoryTransfer.update({
          where: { id: transferId },
          data: { status: "CANCELLED" },
        });
      }
    });

    const updated = await prisma.inventoryTransfer.findUnique({
      where: { id: transferId },
    });

    return res.status(200).json(updated && { ...updated, quantity: toQty(updated.quantity) });
  } catch (error) {
    if (error instanceof TransferRaceError) {
      return res.status(409).json({
        error: "This transfer was just changed by someone else. Refresh to see its current status.",
      });
    }
    if (error instanceof TransferShortError) {
      return res.status(409).json({
        error:
          `Only ${error.available} of the ${error.requested} requested are free to ship from ` +
          `${error.source}. Ship fewer, or correct the stock count first.`,
      });
    }
    logError("Error updating transfer status", error);
    return res.status(500).json({ error: "Failed to update transfer status" });
  }
}

export default requirePermission("inventory.transfer", handler);
