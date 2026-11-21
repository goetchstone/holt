// /app/src/pages/api/print-label/batch.ts
//
// Batch label printing. Supports two modes:
// 1. Auto-route: pass just { productId, copies } -- resolves template and printer
//    from the product's category assignment and tag size matching.
// 2. Manual: pass { productId, templateId, printerId, copies } to override.
// A storeLocationId beside items keeps auto-routed tags to that store's printers.
// A kind beside items (PRODUCT, SALE or LAW, lib/labels/productTag.ts) prints that
// tag for each item as the single print does (printProductTag): a sale tag by the
// store's SALE template, so a scheduled sale's tags print in one go (GAP-06 part
// B). Without one, mode 1 picks the price tag by category, as before.
// What the body asks for, and the 400s, are read by readBatchPrintRequest
// (lib/labels/batchPrintRequest.ts); this looks up the store and prints.

import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { printLabel, printProductTag, resolveRoute } from "@/lib/labelPrinter";
import {
  readBatchPrintRequest,
  type BatchPrintEntry,
  type BatchPrintResult,
} from "@/lib/labels/batchPrintRequest";
import type { ProductTagKind } from "@/lib/labels/productTag";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";

/** Print one item's tags by the mode it asks for; says which printer and template when it chose them. */
async function printOne(args: {
  productId: number;
  templateId?: number;
  printerId?: number;
  kind?: ProductTagKind | null;
  storeName?: string | null;
  copies: number;
}): Promise<{ printer?: string; template?: string }> {
  const { productId, templateId, printerId, kind, storeName, copies } = args;
  if (templateId && printerId) {
    for (let i = 0; i < copies; i++) await printLabel(productId, templateId, printerId);
    return {};
  }
  if (kind) {
    return printProductTag({ productId: Number(productId), kind, storeName, copies });
  }
  const route = await resolveRoute(productId, storeName);
  for (let i = 0; i < copies; i++) {
    await printLabel(productId, route.templateId, route.printerId);
  }
  return { printer: route.printerName, template: route.templateName };
}

/** One item's answer: a failure read from the request as it is, or the job printed. */
async function printEntry(
  entry: BatchPrintEntry,
  kind: ProductTagKind | null,
  storeName: string | undefined,
): Promise<BatchPrintResult> {
  if ("result" in entry) return entry.result;
  const { job } = entry;
  try {
    return {
      productId: job.productId,
      success: true,
      ...(await printOne({ ...job, kind, storeName })),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Print failed";
    return { productId: job.productId, success: false, error: msg };
  }
}

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const request = readBatchPrintRequest(req.body);
    if ("error" in request) return res.status(400).json({ error: request.error });

    const { storeLocationId } = request;
    const store =
      storeLocationId === null
        ? null
        : await prisma.storeLocation.findUnique({
            where: { id: storeLocationId },
            select: { name: true },
          });
    if (storeLocationId !== null && !store) {
      return res.status(400).json({ error: "That store doesn't exist." });
    }

    // One item at a time, in order.
    const results: BatchPrintResult[] = [];
    for (const entry of request.entries) {
      results.push(await printEntry(entry, request.kind, store?.name));
    }

    const successCount = results.filter((r) => r.success).length;
    return res.status(200).json({
      message: `${successCount}/${results.length} labels printed`,
      results,
    });
  } catch (err: unknown) {
    logError("Batch print error", err);
    return res.status(500).json({ error: "Batch print failed" });
  }
}

// rateLimit stays outermost: it rejects a flood of unauthenticated requests
// before the permission check runs, which does DB queries on each call.
// Auth-outermost would let anyone without a session drive that DB load. Do not
// reorder. The same permission as the single tag (pages/api/print-label.ts).
export default rateLimit(
  { windowMs: 60000, maxRequests: 10 },
  "print-label-batch",
)(requirePermission({ anyOf: ["purchasing.receive", "warehouse.operate"] }, handler));
