// /app/src/pages/api/consignment/import/revert-returned-rugs.ts
//
// One-time (idempotent) backfill that reverts ConsignmentItems from SOLD → ON_FLOOR
// for any rug that appears on a RETURNED SalesOrder.
//
// Background: the March 24 SOLD backfill marked items without checking for return orders.
// The forward-going syncConsignmentReturns (added March 28) handles new imports, but
// historical returns need this one-time pass.
//
// Safe to run multiple times — only touches SOLD items with matching RETURNED orders.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { isMarjanRug, toMarjanBarcode, toMarjanCustomerNumber } from "@/lib/consignment";

export default requireAuthWithRole(
  ["ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
      // Collect all partNos / barcodes from RETURNED orders that look like rug M-numbers.
      const returnedOrders = await prisma.salesOrder.findMany({
        where: { status: "RETURNED" },
        select: {
          orderno: true,
          lineItems: {
            select: { partNo: true, barcode: true },
          },
        },
      });

      const rugBarcodes = new Set<string>();
      const rugCustomerNumbers = new Set<string>();
      for (const order of returnedOrders) {
        for (const li of order.lineItems) {
          const candidate = li.partNo ?? li.barcode;
          if (candidate && isMarjanRug(candidate)) {
            rugBarcodes.add(toMarjanBarcode(candidate));
            const cn = toMarjanCustomerNumber(candidate);
            if (cn) rugCustomerNumbers.add(cn);
          }
        }
      }

      if (rugBarcodes.size === 0 && rugCustomerNumbers.size === 0) {
        return res.status(200).json({
          returnedOrdersScanned: returnedOrders.length,
          rugBarcodesFound: 0,
          itemsReverted: 0,
          itemsAlreadyOnFloor: 0,
        });
      }

      // Find SOLD ConsignmentItems matching by barcode OR customerNumber.
      // Barcode matches the Marjan internal rug ID; customerNumber matches
      // the POS product number (these can differ for the same rug).
      const soldItems = await prisma.consignmentItem.findMany({
        where: {
          status: "SOLD",
          OR: [
            { barcode: { in: [...rugBarcodes] } },
            { customerNumber: { in: [...rugCustomerNumbers] } },
          ],
        },
        select: { id: true, barcode: true, customerNumber: true },
      });

      let itemsReverted = 0;
      const itemsAlreadyOnFloor = rugBarcodes.size - soldItems.length;

      for (const item of soldItems) {
        await prisma.consignmentItem.update({
          where: { id: item.id },
          data: {
            status: "ON_FLOOR",
            salesOrderId: null,
            saleDate: null,
            saleTransactionId: null,
            saleCustomerName: null,
            updatedBy: session.user.email,
          },
        });
        itemsReverted++;
      }

      return res.status(200).json({
        returnedOrdersScanned: returnedOrders.length,
        rugBarcodesFound: rugBarcodes.size,
        itemsReverted,
        itemsAlreadyOnFloor,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backfill failed";
      return res.status(500).json({ error: message });
    }
  },
);
