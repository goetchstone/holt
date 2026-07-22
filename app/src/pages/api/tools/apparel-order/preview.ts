// /app/src/pages/api/tools/apparel-order/preview.ts
//
// Parse an uploaded apparel vendor order PDF and return the normalized
// draft for the Apparel Order Import tool. Read-only: nothing is written
// here -- the buyer reviews/edits the returned rows in the UI, then
// POSTs them to commit.ts to create the BuyerDraftPurchaseOrder + items.
// The vendor-specific parsers stay server-only (pdf-parse); dispatch is
// by the registry format id, ported from furniture-configurator's
// apparel-order/preview.ts.
//
// ADMIN-only: this tool's output feeds the ADMIN-only Buyer Drafts domain
// (docs/domains/buyer-drafts.md), so it's gated the same as the
// buyer-drafts/* admin endpoints rather than FC's ALL_STAFF_ROLES.

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { createSecureForm } from "@/lib/secureUpload";
import { parseNuOrderPDF } from "@/lib/pricing/nuorderParser";
import { parseNuOrderPrintoutPDF } from "@/lib/pricing/nuorderPrintoutParser";
import { parseZSupplyPDF } from "@/lib/pricing/zSupplyParser";
import { parseFrankEileenPDF } from "@/lib/pricing/frankEileenParser";
import {
  APPAREL_VENDOR_FORMATS,
  normalizeNuOrder,
  normalizeNuOrderPrintout,
  normalizeZSupply,
  normalizeFrankEileen,
  type ApparelOrderDraft,
  type ApparelVendorFormat,
} from "@/lib/apparelOrderVendors";
import { logError } from "@/lib/logger";

export const config = { api: { bodyParser: false } };

// Dispatch by the registry entry's parser -- several vendor formats
// (Rails, Rag & Bone, Faherty, Favorite Daughter, generic) share the
// NuOrder parser but carry their own catalog vendor name + part-number
// prefix.
async function parseFor(
  entry: ApparelVendorFormat,
  buffer: Buffer,
): Promise<ApparelOrderDraft | null> {
  switch (entry.parser) {
    case "nuorder":
      return normalizeNuOrder(await parseNuOrderPDF(buffer), entry);
    case "nuorder-printout":
      return normalizeNuOrderPrintout(await parseNuOrderPrintoutPDF(buffer), entry);
    case "zsupply":
      return normalizeZSupply(await parseZSupplyPDF(buffer), entry);
    case "frank-eileen": {
      // F&E sends TWO document shapes for the same PO: the acknowledgement
      // (size-grid text blocks) and the NuOrder order printout. Try the ack
      // parser first, then fall back to the printout parser with the same
      // registry entry (FAE prefix, catalog vendor name) so whichever
      // document the buyer has Just Works.
      const ack = normalizeFrankEileen(await parseFrankEileenPDF(buffer));
      if (ack.rows.length > 0) return ack;
      return normalizeNuOrderPrintout(await parseNuOrderPrintoutPDF(buffer), entry);
    }
    default:
      return null;
  }
}

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const form = createSecureForm("PDF");
    const [fields, files] = await form.parse(req);
    const format = Array.isArray(fields.format) ? fields.format[0] : fields.format;
    const file = Array.isArray(files.file) ? files.file[0] : files.file;

    const entry = APPAREL_VENDOR_FORMATS.find((f) => f.id === format && f.parser !== null);
    if (!entry) {
      return res.status(400).json({ error: `Unknown PDF format "${format ?? ""}"` });
    }
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const draft = await parseFor(entry, fs.readFileSync(file.filepath));
    if (!draft?.rows.length) {
      return res.status(400).json({ error: "No line items found in PDF" });
    }
    return res.status(200).json(draft);
  } catch (err) {
    logError("Apparel order preview parse failed", err);
    const message = err instanceof Error ? err.message : "Parse failed";
    return res.status(500).json({ error: message });
  }
});
