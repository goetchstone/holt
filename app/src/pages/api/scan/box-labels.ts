// /app/src/pages/api/scan/box-labels.ts
//
// Print the box labels for units just received (lib/labels/boxLabel.ts) on
// the store's printer loaded for BOX labels.
//
// POST { productId, units: 1-50, purchaseOrderId?, storeLocationId? }

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { LabelSetupError, printZpl, routeContextLabel } from "@/lib/labelPrinter";
import { renderBoxLabels } from "@/lib/labels/boxLabel";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const productId = Number(req.body?.productId);
  const units = Number(req.body?.units);
  if (!Number.isInteger(productId))
    return res.status(400).json({ error: "productId is required." });
  if (!Number.isInteger(units) || units < 1 || units > 50) {
    return res.status(400).json({ error: "units must be 1 to 50." });
  }
  try {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, productNumber: true, boxesPerUnit: true },
    });
    if (!product) return res.status(404).json({ error: "Product not found" });
    const po = req.body?.purchaseOrderId
      ? await prisma.purchaseOrder.findUnique({
          where: { id: Number(req.body.purchaseOrderId) },
          select: { poNumber: true },
        })
      : null;
    const store = req.body?.storeLocationId
      ? await prisma.storeLocation.findUnique({
          where: { id: Number(req.body.storeLocationId) },
          select: { name: true },
        })
      : null;
    const route = await routeContextLabel("BOX", store?.name);
    const zpl = renderBoxLabels(route.template.zplTemplate, product, units, po?.poNumber ?? null);
    await printZpl(route.printerId, zpl);
    return res.status(200).json({ printed: units * Math.max(1, product.boxesPerUnit ?? 1) });
  } catch (error) {
    if (error instanceof LabelSetupError) return res.status(400).json({ error: error.message });
    logError("Error printing box labels", error);
    const message = error instanceof Error ? error.message : "Failed to print box labels";
    return res.status(502).json({ error: message });
  }
}

export default requirePermission({ anyOf: ["purchasing.receive", "warehouse.operate"] }, handler);
