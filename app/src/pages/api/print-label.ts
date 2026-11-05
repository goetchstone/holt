// /app/src/pages/api/print-label.ts
//
// Print a product's tag on a Zebra printer over TCP (lib/labelPrinter.ts).
//
// POST { productId, kind?, storeLocationId?, copies? } chooses the template and
// printer itself: a price tag by the product's category, a sale or law tag by the
// store's template of that kind. kind is PRODUCT unless said. With a store, only
// its printers.
//
// POST { productId, templateId, printerId } prints that template on that printer.
//
// It answers with what it did, never the rendered label: a template can carry
// the real cost, and who may print a tag isn't who may see cost.

import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { LabelSetupError, printLabel, printProductTag } from "@/lib/labelPrinter";
import { isProductTagKind, MAX_TAG_COPIES } from "@/lib/labels/productTag";
import { logError } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";

async function storeNameFor(storeLocationId: unknown): Promise<string | null> {
  if (storeLocationId === undefined || storeLocationId === null || storeLocationId === "") {
    return null;
  }
  const store = await prisma.storeLocation.findUnique({
    where: { id: Number(storeLocationId) },
    select: { name: true },
  });
  if (!store) throw new LabelSetupError("That store doesn't exist.");
  return store.name;
}

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { productId, templateId, printerId, kind = "PRODUCT", copies = 1 } = req.body;
    const product = Number(productId);
    if (!Number.isInteger(product)) {
      return res.status(400).json({ error: "productId is required." });
    }

    if (templateId && printerId) {
      await printLabel(product, Number(templateId), Number(printerId));
      return res.status(200).json({ message: "Label sent to printer" });
    }

    if (!isProductTagKind(kind)) {
      return res.status(400).json({ error: "kind must be PRODUCT, SALE or LAW." });
    }
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_TAG_COPIES) {
      return res.status(400).json({ error: `copies must be 1 to ${MAX_TAG_COPIES}.` });
    }
    const sent = await printProductTag({
      productId: product,
      kind,
      storeName: await storeNameFor(req.body.storeLocationId),
      copies,
    });
    return res.status(200).json({ message: `Sent to ${sent.printer}`, ...sent });
  } catch (err: unknown) {
    if (err instanceof LabelSetupError) return res.status(400).json({ error: err.message });
    logError("Print error", err);
    const message = err instanceof Error ? err.message : "The tag did not print.";
    return res.status(502).json({ error: message });
  }
}

// rateLimit stays outermost: it rejects a flood of unauthenticated requests
// before the permission check runs, which does DB queries on each call.
// Auth-outermost would let anyone without a session drive that DB load. Do not
// reorder. The permission is the box labels' (pages/api/scan/box-labels.ts): this
// was a role list that left out a buyer who could reach the receiving screen.
export default rateLimit({ windowMs: 60000, maxRequests: 30 })(
  requirePermission({ anyOf: ["purchasing.receive", "warehouse.operate"] }, handler),
);
