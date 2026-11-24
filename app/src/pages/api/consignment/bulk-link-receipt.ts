// /app/src/pages/api/consignment/bulk-link-receipt.ts
//
// Assigns a set of ConsignmentItems to a ConsignmentReceipt (Receiving Gaps'
// Link to Receipt).
// If receiptId is null a new receipt is created with the provided date and ref.
// "Write purchase orders" alone decides who may, the key Receive Shipment's
// manifest import also creates receipts under. Until 2026-11 a second check
// also required the staff role to be MANAGER or ADMIN by name, which refused
// the Owner, the General Manager and every custom role.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { logger } from "@/lib/logger";

import { requirePermission } from "@/lib/auth/requireAuth";
export default requirePermission(
  "purchasing.write",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { itemIds, receiptId, newReceiptDate, newReceiptRef, vendorId } = req.body as {
      itemIds: number[];
      receiptId?: number;
      newReceiptDate?: string;
      newReceiptRef?: string;
      vendorId?: number;
    };

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: "itemIds array is required" });
    }

    if (receiptId == null && (!newReceiptDate || !vendorId)) {
      return res
        .status(400)
        .json({ error: "newReceiptDate and vendorId are required when creating a new receipt" });
    }

    let targetReceiptId: number;
    let linked = 0;

    await prisma.$transaction(async (tx) => {
      if (receiptId != null) {
        // Verify receipt exists
        const receipt = await tx.consignmentReceipt.findUnique({ where: { id: receiptId } });
        if (!receipt) throw new Error("Receipt not found");
        targetReceiptId = receipt.id;
      } else {
        // Create new receipt
        const receipt = await tx.consignmentReceipt.create({
          data: {
            vendorId: vendorId!,
            receiptDate: new Date(newReceiptDate!),
            manifestRef: newReceiptRef || null,
            itemCount: itemIds.length,
            createdBy: session.user!.email!,
          },
        });
        targetReceiptId = receipt.id;
      }

      const result = await tx.consignmentItem.updateMany({
        where: { id: { in: itemIds }, consignmentReceiptId: null },
        data: { consignmentReceiptId: targetReceiptId },
      });
      linked = result.count;

      // Keep itemCount accurate on the receipt
      if (receiptId != null && linked > 0) {
        const actualCount = await tx.consignmentItem.count({
          where: { consignmentReceiptId: targetReceiptId },
        });
        await tx.consignmentReceipt.update({
          where: { id: targetReceiptId },
          data: { itemCount: actualCount },
        });
      }
    }, TX_TIMEOUT.LONG);

    logger.info("Bulk consignment receipt link", {
      receiptId: targetReceiptId!,
      linked,
      user: session.user.email,
    });

    return res.status(200).json({ receiptId: targetReceiptId!, linked });
  },
);
