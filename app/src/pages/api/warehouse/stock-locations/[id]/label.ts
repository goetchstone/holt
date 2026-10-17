// /app/src/pages/api/warehouse/stock-locations/[id]/label.ts
//
// Print a place's label (lib/labels/placeLabel.ts) on the store's printer
// loaded for LOCATION labels (labelPrinter.routeContextLabel). For whoever
// sets places up, and for warehouse staff relabelling a bay.
//
// POST { copies?: 1-20 }

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { LabelSetupError, printZpl, routeContextLabel } from "@/lib/labelPrinter";
import { placeLabelFields } from "@/lib/labels/placeLabel";
import { renderTemplate } from "@/lib/labels/renderTemplate";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const placeId = Number(req.query.id);
  if (!Number.isInteger(placeId)) return res.status(400).json({ error: "Invalid place ID" });
  const copies = req.body?.copies == null ? 1 : Number(req.body.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 20) {
    return res.status(400).json({ error: "copies must be 1 to 20." });
  }
  try {
    const exists = await prisma.stockLocation.findUnique({
      where: { id: placeId },
      select: { id: true },
    });
    if (!exists) return res.status(404).json({ error: "Place not found" });
    const { storeName, fields } = await placeLabelFields(prisma, placeId);
    const route = await routeContextLabel("LOCATION", storeName);
    const zpl = renderTemplate(route.template.zplTemplate, fields);
    await printZpl(route.printerId, zpl.repeat(copies));
    return res.status(200).json({ printed: copies, barcode: fields.barcode });
  } catch (error) {
    if (error instanceof LabelSetupError) return res.status(400).json({ error: error.message });
    logError("Error printing a place label", error);
    const message = error instanceof Error ? error.message : "Failed to print the label";
    // A printer that did not answer is the operator's to fix, and says how.
    return res.status(502).json({ error: message });
  }
}

export default requirePermission(
  { anyOf: ["inventory.locations.manage", "warehouse.operate"] },
  handler,
);
