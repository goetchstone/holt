// /app/src/pages/api/consignment/import/vendor-returns.ts
//
// Imports a batch of barcodes as a vendor return shipment. Creates a
// ConsignmentVendorReturn record and marks matching ConsignmentItems
// as RETURNED_VENDOR.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { barcodes, returnDate, notes } = req.body;

    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ error: "barcodes must be a non-empty array" });
    }

    const trimmed = barcodes
      .map((b: string) => String(b).trim())
      .filter((b: string) => b.length > 0);

    try {
      const marjanVendor = await prisma.vendor.findFirst({
        where: { name: { contains: "Marjan", mode: "insensitive" } },
        select: { id: true },
      });
      if (!marjanVendor) return res.status(404).json({ error: "Marjan vendor not found" });

      // Look up items by barcode
      const items = await prisma.consignmentItem.findMany({
        where: { barcode: { in: trimmed } },
        select: { id: true, barcode: true, status: true },
      });

      const foundBarcodes = new Set(items.map((i) => i.barcode));
      const notFound = trimmed.filter((b: string) => !foundBarcodes.has(b));
      const alreadyReturned = items
        .filter((i) => i.status === "RETURNED_VENDOR")
        .map((i) => i.barcode);
      const returnable = items.filter((i) => i.status !== "RETURNED_VENDOR");

      if (returnable.length === 0) {
        return res.json({
          returnId: null,
          itemsReturned: 0,
          notFound,
          alreadyReturned,
        });
      }

      const parsedDate = returnDate ? new Date(returnDate) : new Date();

      const vendorReturn = await prisma.consignmentVendorReturn.create({
        data: {
          vendorId: marjanVendor.id,
          returnDate: parsedDate,
          status: "CONFIRMED",
          notes: notes || null,
          createdBy: session.user.email,
        },
      });

      for (const item of returnable) {
        const wasPaid = item.status === "PAID";
        await prisma.consignmentItem.update({
          where: { id: item.id },
          data: {
            status: "RETURNED_VENDOR",
            returnedDate: parsedDate,
            vendorReturnId: vendorReturn.id,
            creditOwed: wasPaid ? true : undefined,
            salesOrderId: null,
            saleDate: null,
            saleTransactionId: null,
            saleCustomerName: null,
            updatedBy: session.user.email,
          },
        });
      }

      return res.json({
        returnId: vendorReturn.id,
        itemsReturned: returnable.length,
        notFound,
        alreadyReturned,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  },
);
