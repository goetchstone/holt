// /app/src/pages/api/print-label/batch.ts
//
// Batch label printing. Supports two modes:
// 1. Auto-route: pass just { productId, copies } -- resolves template and printer
//    from the product's category assignment and tag size matching.
// 2. Manual: pass { productId, templateId, printerId, copies } to override.

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { printLabel, autoRoutePrint, resolveRoute } from "@/lib/labelPrinter";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";

const MAX_BATCH_SIZE = 50;
const MAX_COPIES = 10;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array is required" });
    }

    if (items.length > MAX_BATCH_SIZE) {
      return res
        .status(400)
        .json({ error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE} items` });
    }

    const results: {
      productId: number;
      success: boolean;
      printer?: string;
      template?: string;
      error?: string;
    }[] = [];

    for (const item of items) {
      const { productId, templateId, printerId, copies = 1 } = item;

      if (!productId) {
        results.push({ productId, success: false, error: "productId is required" });
        continue;
      }

      const clampedCopies = Math.min(Math.max(1, copies), MAX_COPIES);

      try {
        if (templateId && printerId) {
          for (let i = 0; i < clampedCopies; i++) {
            await printLabel(productId, templateId, printerId);
          }
          results.push({ productId, success: true });
        } else {
          const route = await resolveRoute(productId);
          for (let i = 0; i < clampedCopies; i++) {
            await autoRoutePrint(productId);
          }
          results.push({
            productId,
            success: true,
            printer: route.printerName,
            template: route.templateName,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Print failed";
        results.push({ productId, success: false, error: msg });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    return res.status(200).json({
      message: `${successCount}/${results.length} labels printed`,
      results,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    logError("Batch print error", err);
    return res.status(500).json({ error: message });
  }
}

// rateLimit stays outermost: it rejects a flood of unauthenticated requests
// before requireAuthWithRole runs, which does two DB queries per call (the
// StaffMember lookup and the privileged-count). Auth-outermost would let
// anyone without a session drive that DB load. Do not reorder.
export default rateLimit({ windowMs: 60000, maxRequests: 10 })(
  requireAuthWithRole(["MANAGER", "ADMIN", "WAREHOUSE"], handler),
);
