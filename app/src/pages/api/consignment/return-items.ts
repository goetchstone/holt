// /app/src/pages/api/consignment/return-items.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getPrimaryConsignmentVendorId } from "@/lib/consignmentVendor";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requirePermission("inventory.transfer", async (req, res, session) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { barcodes } = req.body;

  if (!Array.isArray(barcodes) || barcodes.length === 0) {
    return res.status(400).json({ error: "barcodes must be a non-empty array of strings" });
  }

  const trimmed = barcodes.map((b: string) => b.trim());

  try {
    const items = await prisma.consignmentItem.findMany({
      where: { barcode: { in: trimmed } },
      select: { id: true, barcode: true, status: true },
    });

    const foundBarcodes = items.map((i) => i.barcode);
    const notFound = trimmed.filter((b: string) => !foundBarcodes.includes(b));
    if (notFound.length > 0) {
      return res.status(404).json({
        error: `Barcodes not found: ${notFound.join(", ")}`,
        notFound,
      });
    }

    const invalid = items.filter((i) => i.status !== "ON_FLOOR" && i.status !== "MISSING");
    if (invalid.length > 0) {
      return res.status(400).json({
        error: "Items must be ON_FLOOR or MISSING to return to vendor",
        invalidItems: invalid.map((i) => ({
          barcode: i.barcode,
          status: i.status,
        })),
      });
    }

    // The consigning vendor to record the return against, found by flag rather
    // than by name. Null when the deployment does not consign -- the code below
    // already handles that, and inventing a vendor would be worse.
    const consignmentVendorId = await getPrimaryConsignmentVendorId(prisma);

    const now = new Date();
    const userEmail = session.user?.email ?? null;

    // Create a ConsignmentVendorReturn to group this batch of returns
    const vendorReturn = consignmentVendorId
      ? await prisma.consignmentVendorReturn.create({
          data: {
            vendorId: consignmentVendorId,
            returnDate: now,
            status: "PENDING",
            createdBy: userEmail,
          },
        })
      : null;

    const result = await prisma.$transaction(
      items.map((item) =>
        prisma.consignmentItem.update({
          where: { id: item.id },
          data: {
            status: "RETURNED_VENDOR",
            returnedDate: now,
            vendorReturnId: vendorReturn?.id ?? null,
            updatedBy: userEmail,
          },
        }),
      ),
    );

    return res.json({
      updated: result.length,
      vendorReturnId: vendorReturn?.id ?? null,
    });
  } catch (error) {
    logError("Error returning consignment items", error);
    return res.status(500).json({ error: "Failed to return consignment items" });
  }
});
