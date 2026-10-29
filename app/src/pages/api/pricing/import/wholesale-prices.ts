// /app/src/pages/api/pricing/import/wholesale-prices.ts
//
// POST: import a vendor's wholesale grade-based price book. The route checks
// the method, validates the body and turns the outcome into a status; the
// import itself is lib/pricing/importWholesaleBook.ts, which the demo seed's
// price books call too.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { wholesaleImportSchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation/validate";
import { ValidationError } from "@/lib/apiHandler";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
import { importWholesaleBook } from "@/lib/pricing/importWholesaleBook";

export { SHRINK_GUARD_RATIO } from "@/lib/pricing/importWholesaleBook";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

// Exported for the integration tests, which drive it with a fake req/res the
// way cartPricingEndToEnd does; the default export is the gated route.
export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  let validated;
  try {
    validated = validateBody(wholesaleImportSchema, req.body);
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      return res
        .status(400)
        .json({ error: getErrorMessage(err, "Unknown error"), details: err.details });
    }
    throw err;
  }

  try {
    const outcome = await importWholesaleBook(validated, session.user?.email || "unknown");
    switch (outcome.kind) {
      case "vendor-not-found":
        return res.status(404).json({ error: "Vendor not found" });
      case "shrink-refused":
        // A renew that would retire most of the book is far more often the
        // wrong book or a partial parse; the operator confirms (rule 63).
        return res.status(409).json({
          error:
            `This book would retire ${outcome.existing - outcome.incoming} of ${outcome.existing} ` +
            `active ${outcome.sourceBook} styles for ${outcome.vendorName}. If that is really the new catalog, ` +
            `re-submit with confirmShrink: true; if not, this is the wrong book or a partial parse.`,
          existing: outcome.existing,
          incoming: outcome.incoming,
          sourceBook: outcome.sourceBook,
        });
      case "nothing-imported":
        // Rolled back: nothing was retired or written; say so, not "success".
        return res.status(422).json({
          success: false,
          importedCount: 0,
          skippedCount: outcome.skippedCount,
          errors: outcome.errors,
          error: "No styles could be imported from this book; nothing was changed.",
        });
      case "ok":
        return res.status(200).json({
          success: true,
          importedCount: outcome.importedCount,
          skippedCount: outcome.skippedCount,
          errors: outcome.errors,
          priceListId: outcome.priceListId,
        });
    }
  } catch (error: unknown) {
    logError("Wholesale import error", error);
    return res.status(500).json({ error: "Import failed" });
  }
}

export default requirePermission("catalog.pricing", handler);
