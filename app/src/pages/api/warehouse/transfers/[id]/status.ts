// /app/src/pages/api/warehouse/transfers/[id]/status.ts
//
// Advances a transfer and moves its stock, in one transaction. What moves is
// decided in lib/inventory/transfers.ts:
// DRAFT -> IN_TRANSIT: the units go to the source store's in-transit place, or
//                      the ship is refused (409) if the source is short
// IN_TRANSIT -> RECEIVED: `quantity` (default: all still on its way) arrives;
//                      the transfer stays IN_TRANSIT until all of it has
// IN_TRANSIT -> CANCELLED: what is still on its way goes back where it left

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { toQty } from "@/lib/inventory/quantity";
import { parseQty } from "@/lib/inventory/qtyInput";
import {
  cancelTransfer,
  receiveTransfer,
  shipTransfer,
  TransferQuantityError,
  TransferShortError,
  transferForClient,
} from "@/lib/inventory/transfers";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

/** Another request changed this transfer first. */
class TransferRaceError extends Error {}

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

    const actor = session.user?.email ?? null;
    const receiveQty =
      newStatus === "RECEIVED" && req.body.quantity != null ? parseQty(req.body.quantity) : null;
    if (newStatus === "RECEIVED" && req.body.quantity != null && receiveQty == null) {
      return res.status(400).json({ error: "quantity must be a positive number." });
    }

    await prisma.$transaction(async (tx) => {
      // Claim the change before moving any stock: only the request that finds
      // the transfer as it read it may proceed. Without this a double-clicked
      // "Ship" ran twice and took the units twice -- the checks above happen
      // outside this transaction.
      const claim = (data: Parameters<typeof tx.inventoryTransfer.updateMany>[0]["data"]) =>
        tx.inventoryTransfer.updateMany({
          where: {
            id: transferId,
            status: transfer.status,
            receivedQuantity: transfer.receivedQuantity,
          },
          data,
        });

      if (newStatus === "IN_TRANSIT") {
        if ((await claim({ status: "IN_TRANSIT", shippedAt: new Date() })).count === 0) {
          throw new TransferRaceError();
        }
        await shipTransfer(tx, transfer, actor);
      } else if (newStatus === "RECEIVED") {
        const remaining = toQty(transfer.quantity) - toQty(transfer.receivedQuantity);
        const take = receiveQty ?? remaining;
        const willComplete = take >= remaining - 0.0005;
        const claimed = await claim({
          receivedQuantity: Math.min(
            toQty(transfer.quantity),
            toQty(transfer.receivedQuantity) + take,
          ),
          ...(willComplete
            ? { status: "RECEIVED", receivedAt: new Date(), receivedByUserId: actor }
            : {}),
        });
        if (claimed.count === 0) throw new TransferRaceError();
        await receiveTransfer(tx, transfer, take, actor);
      } else if (newStatus === "CANCELLED") {
        if ((await claim({ status: "CANCELLED" })).count === 0) throw new TransferRaceError();
        if (transfer.status === "IN_TRANSIT") await cancelTransfer(tx, transfer, actor);
      }
    });

    const updated = await prisma.inventoryTransfer.findUnique({
      where: { id: transferId },
    });

    return res.status(200).json(updated && transferForClient(updated));
  } catch (error) {
    if (error instanceof TransferRaceError) {
      return res.status(409).json({
        error: "This transfer was just changed by someone else. Refresh to see its current status.",
      });
    }
    if (error instanceof TransferShortError) {
      return res.status(409).json({
        error:
          `Only ${error.available} of the ${error.requested} requested are at ` +
          `${error.source}. Move fewer, or correct the stock count first.`,
      });
    }
    if (error instanceof TransferQuantityError) {
      return res.status(400).json({ error: error.message });
    }
    logError("Error updating transfer status", error);
    return res.status(500).json({ error: "Failed to update transfer status" });
  }
}

export default requirePermission("inventory.transfer", handler);
