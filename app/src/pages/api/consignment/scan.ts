// /app/src/pages/api/consignment/scan.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuth } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requireAuth(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { barcode } = req.body;

  if (!barcode || typeof barcode !== "string") {
    return res.status(400).json({ error: "barcode is required" });
  }

  try {
    const item = await prisma.consignmentItem.findUnique({
      where: { barcode: barcode.trim() },
      include: {
        vendor: { select: { id: true, name: true } },
        storeLocation: { select: { id: true, name: true } },
      },
    });

    if (!item) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json({
      id: item.id,
      barcode: item.barcode,
      rugNumber: item.rugNumber,
      quality: item.quality,
      size: item.size,
      cost: Number(item.cost),
      anchorPrice: item.anchorPrice ? Number(item.anchorPrice) : null,
      retailPrice: item.retailPrice ? Number(item.retailPrice) : null,
      sellingPrice: item.sellingPrice ? Number(item.sellingPrice) : null,
      status: item.status,
      year: item.year,
      vendor: item.vendor,
      storeLocation: item.storeLocation,
    });
  } catch (error) {
    logError("Error looking up consignment item by barcode", error);
    return res.status(500).json({ error: "Failed to look up consignment item" });
  }
});
