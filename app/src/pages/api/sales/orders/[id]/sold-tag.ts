// /app/src/pages/api/sales/orders/[id]/sold-tag.ts
//
// Print a "sold" tag for one line of an order (lib/labels/soldTag.ts), on a printer
// at the order's store loaded for the store's sold-tag template.
//
// POST { lineItemId }

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { LabelSetupError, printZpl, routeContextLabel } from "@/lib/labelPrinter";
import { renderSoldTag } from "@/lib/labels/soldTag";
import { logError } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const orderId = Number(req.query.id);
  const lineItemId = Number(req.body?.lineItemId);
  if (!Number.isInteger(orderId) || !Number.isInteger(lineItemId)) {
    return res.status(400).json({ error: "An order and a line are required." });
  }
  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: orderId },
      select: { storeLocation: true, store: { select: { name: true } } },
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    const storeName = order.store?.name ?? order.storeLocation;
    const route = await routeContextLabel("SOLD", storeName);
    await printZpl(
      route.printerId,
      await renderSoldTag(orderId, lineItemId, route.template.zplTemplate),
    );
    return res.status(200).json({ message: "Sold tag sent to the printer" });
  } catch (error) {
    if (error instanceof LabelSetupError) return res.status(400).json({ error: error.message });
    logError("Error printing a sold tag", error);
    const message = error instanceof Error ? error.message : "Failed to print the sold tag";
    return res.status(502).json({ error: message });
  }
}

export default requirePermission({ anyOf: ["sales.write", "warehouse.operate"] }, handler);
