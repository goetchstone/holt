// /app/src/pages/api/purchasing/orders/[id]/pdf.ts
//
// GAP-01: GET -- the purchase order as a PDF for its vendor, to print or save
// (lib/purchasing/purchaseOrderDocument.ts). REST because the response is
// binary. "View purchasing", like the PO screen it is printed from; prices only
// for a holder of "View cost" (strip, never deny).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission, type CallerAccess } from "@/lib/auth/requireAuth";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { logError } from "@/lib/logger";
import { purchaseOrderDocument } from "@/lib/purchasing/purchaseOrderDocument";
import { PurchaseOrderError } from "@/lib/purchasing/stockPurchaseOrder";

/** Exported for integration tests. */
export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  _session: Session,
  access: CallerAccess,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const poId = Number.parseInt(String(req.query.id), 10);
  if (Number.isNaN(poId)) return res.status(400).json({ error: "Invalid purchase order ID." });

  try {
    const doc = await purchaseOrderDocument(poId, canViewCost(access));
    res.setHeader("Content-Type", "application/pdf");
    // inline: the browser opens it to print; its own save keeps the filename.
    res.setHeader("Content-Disposition", `inline; filename="${doc.filename}"`);
    return res.status(200).send(doc.pdf);
  } catch (err) {
    if (err instanceof PurchaseOrderError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("Purchase order PDF generation failed", err);
    return res.status(500).json({ error: "Failed to generate the purchase order PDF." });
  }
}

export default requirePermission("purchasing.read", handler, WITH_COST);
