// /app/src/pages/api/returns/[id]/status.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { isValidTransition } from "@/lib/returnService";
import type { ReturnStatus } from "@prisma/client";
import { logError } from "@/lib/logger";
import { toQty } from "@/lib/inventory/quantity";
import { resolveOrderStoreLocationId } from "@/lib/inventory/orderInventorySync";
import {
  putBackReturn,
  receiveReturnStock,
  ReturnDispositionError,
  writeOffReturn,
} from "@/lib/inventory/returnStock";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid return ID" });

  const { status: newStatus, ...fields } = req.body;
  if (!newStatus) return res.status(400).json({ error: "status is required" });

  const changedBy = session.user?.email || null;

  try {
    const ret = await prisma.return.findUniqueOrThrow({ where: { id } });

    if (!isValidTransition(ret.status, newStatus as ReturnStatus)) {
      return res.status(400).json({
        error: `Cannot transition from ${ret.status} to ${newStatus}`,
      });
    }
    // Once money moved the return is booked as its own order and refunds
    // stand against it; cancelling would leave both behind.
    if (newStatus === "CANCELLED" && ret.returnOrderId != null) {
      return res.status(409).json({
        error: "This return has been refunded or booked, so it cannot be cancelled.",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Claim the transition before any side effect: only the request that
      // finds the return still in the status it read may proceed. Without this
      // a double-submitted RESTOCKED added the unit to stock twice -- the
      // transition check above happens outside this transaction.
      const claimed = await tx.return.updateMany({
        where: { id, status: ret.status },
        data: { status: newStatus },
      });
      if (claimed.count === 0) return null;

      const updateData: any = {
        status: newStatus,
        updatedBy: changedBy,
      };

      // Side effects per transition
      switch (newStatus) {
        case "PICKUP_SCHEDULED":
          if (fields.pickupDate) updateData.pickupDate = new Date(fields.pickupDate);
          if (fields.pickupTimeSlot) updateData.pickupTimeSlot = fields.pickupTimeSlot;
          if (fields.pickupNotes) updateData.pickupNotes = fields.pickupNotes;
          if (fields.pickupAddressId)
            updateData.pickupAddressId = Number.parseInt(fields.pickupAddressId);
          break;

        case "RECEIVED": {
          // The piece is back: it goes into the store's returns place, owned
          // and waiting in that store's returned-stock queue, recorded here so
          // putting it back or writing it off takes it from where it is (rule
          // 60). The store is the one named, or the one it was received at, or
          // the order's own -- never a reason to refuse the customer.
          updateData.receivedAt = new Date();
          if (fields.receivedById) updateData.receivedById = Number.parseInt(fields.receivedById);
          const order = await tx.salesOrder.findUnique({
            where: { id: ret.salesOrderId },
            select: { storeLocationId: true, storeLocation: true },
          });
          const storeLocationId =
            (fields.receivedLocationId ? Number.parseInt(fields.receivedLocationId) : null) ??
            ret.receivedLocationId ??
            order?.storeLocationId ??
            (await resolveOrderStoreLocationId(order?.storeLocation, tx));
          if (storeLocationId == null) {
            throw new ReturnDispositionError("Choose the store the piece came back to.", 400);
          }
          updateData.receivedLocationId = storeLocationId;
          updateData.receivedStockLocationId = await receiveReturnStock(
            tx,
            ret,
            storeLocationId,
            changedBy,
          );
          break;
        }

        case "INSPECTED":
          updateData.inspectedAt = new Date();
          if (fields.inspectedById)
            updateData.inspectedById = Number.parseInt(fields.inspectedById);
          if (fields.inspectionCondition)
            updateData.inspectionCondition = fields.inspectionCondition;
          if (fields.inspectionNotes) updateData.inspectionNotes = fields.inspectionNotes;
          break;

        // Putting the piece back or writing it off is the returned-stock
        // queue's job (lib/inventory/returnStock.ts); these two statuses do the
        // same, for screens that still close a return that way.
        case "RESTOCKED": {
          const storeLocationId =
            (fields.restockedLocationId ? Number.parseInt(fields.restockedLocationId) : null) ??
            ret.receivedLocationId;
          if (storeLocationId == null) {
            throw new ReturnDispositionError("Choose the store to put the piece back at.", 400);
          }
          await putBackReturn(tx, ret, {
            storeLocationId,
            stockLocationId: fields.restockedStockLocationId
              ? Number.parseInt(fields.restockedStockLocationId)
              : null,
            actor: changedBy,
          });
          break;
        }

        case "WRITTEN_OFF":
          await writeOffReturn(tx, ret, {
            reason: fields.writeOffReason ?? null,
            actor: changedBy,
          });
          break;

        case "CANCELLED":
          break;
      }

      const updated = await tx.return.update({
        where: { id },
        data: updateData,
      });

      // Audit log
      await tx.orderChangeLog.create({
        data: {
          salesOrderId: ret.salesOrderId,
          lineItemId: ret.lineItemId,
          changeType: `RETURN_${newStatus}`,
          previousValue: ret.status,
          newValue: newStatus,
          reason: fields.reason || undefined,
          changedBy,
        },
      });

      return updated;
    });

    if (result === null) {
      return res.status(409).json({
        error: "This return was just changed by someone else. Refresh to see its current status.",
      });
    }
    return res.status(200).json({ ...result, quantity: toQty(result.quantity) });
  } catch (error) {
    if (error instanceof ReturnDispositionError) {
      return res.status(error.status).json({ error: error.message });
    }
    logError("Error updating return status", error);
    return res.status(500).json({ error: "Failed to update return status" });
  }
}

// The same key as the other returns routes (/api/returns, /api/returns/[id]):
// it was a role list that left out WAREHOUSE, whose staff work the returns
// queue.
export default requirePermission("sales.return", handler);
