// /app/src/pages/api/tools/home-accessory-order/preview.ts
//
// Parse an uploaded home-accessory vendor order file (PDF, or a CSV for the
// Simblist Group export) and return the normalized draft for the Home
// Accessory Order Import tool. Read-only: nothing is written here — commit.ts
// is the endpoint that creates the BuyerDraftPurchaseOrder + BuyerDraftItem
// rows, after the buyer has reviewed/edited/split the preview. The vendor
// parsers stay server-only (pdf-parse / papaparse); dispatch is by the
// registry format id.
//
// ADMIN-only, matching the buyer-drafts admin endpoints this tool feeds
// (docs/domains/buyer-drafts.md: "ADMIN-only — designers and managers don't
// see it").
//
// The selected format arrives as the `format` query param so the correct
// upload preset (PDF vs CSV) can be chosen BEFORE the multipart body is
// parsed — the preset's extension/mime allowlist is the guard, so a PDF
// format rejects a CSV upload and vice versa.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import fs from "node:fs";
import { requirePermission } from "@/lib/auth/requireAuth";
import { createSecureForm } from "@/lib/secureUpload";
import { parseKKOrderPDF } from "@/lib/pricing/kkOrderParser";
import { parseWendoverOrderPDF } from "@/lib/pricing/wendoverOrderParser";
import { parseMarketTimeOrderPDF } from "@/lib/pricing/marketTimeOrderParser";
import { parseBrandWiseOrderPDF } from "@/lib/pricing/brandWiseOrderParser";
import { parseAestheticMovementOrderPDF } from "@/lib/pricing/aestheticMovementOrderParser";
import { parseSuperCatOrderPDF } from "@/lib/pricing/superCatOrderParser";
import { parseSimblistCsvBuffer } from "@/lib/pricing/simblistCsvOrderParser";
import { buyerBoilerplate, parseBeatrizBallOrderPDF } from "@/lib/pricing/beatrizBallOrderParser";
import {
  HOME_ACCESSORY_FORMATS,
  normalizeKKBundle,
  normalizeWendoverOrder,
  normalizeMarketTimeOrder,
  normalizeBrandWiseOrder,
  normalizeAestheticMovementOrder,
  normalizeSuperCatOrder,
  normalizeSimblistOrder,
  normalizeBeatrizBallOrder,
  type HomeAccessoryDraft,
  type HomeAccessoryFormat,
} from "@/lib/homeAccessoryOrders";
import { logError } from "@/lib/logger";

export const config = { api: { bodyParser: false } };

/**
 * How this deployment identifies itself on a vendor's paperwork.
 *
 * Drawn from the org's own settings and store names rather than a literal, so a
 * second deployment's confirmations parse correctly without a code change.
 */
async function buyerIdentityLines(): Promise<string[]> {
  const settings = await prisma.appSettings.findFirst({
    select: { companyName: true, appName: true },
  });
  const stores = await prisma.storeLocation.findMany({ select: { name: true } });
  return buyerBoilerplate(settings?.companyName, settings?.appName, ...stores.map((s) => s.name));
}

async function parseFor(
  entry: HomeAccessoryFormat,
  buffer: Buffer,
): Promise<HomeAccessoryDraft | null> {
  if (entry.parser === "kk-order") {
    return normalizeKKBundle(await parseKKOrderPDF(buffer), entry);
  }
  if (entry.parser === "wendover-order") {
    return normalizeWendoverOrder(await parseWendoverOrderPDF(buffer), entry);
  }
  if (entry.parser === "market-time") {
    return normalizeMarketTimeOrder(await parseMarketTimeOrderPDF(buffer), entry);
  }
  if (entry.parser === "brandwise") {
    return normalizeBrandWiseOrder(await parseBrandWiseOrderPDF(buffer), entry);
  }
  if (entry.parser === "aesthetic-movement") {
    return normalizeAestheticMovementOrder(await parseAestheticMovementOrderPDF(buffer), entry);
  }
  if (entry.parser === "supercat") {
    return normalizeSuperCatOrder(await parseSuperCatOrderPDF(buffer), entry);
  }
  if (entry.parser === "simblist-csv") {
    return normalizeSimblistOrder(parseSimblistCsvBuffer(buffer), entry);
  }
  if (entry.parser === "beatriz-ball") {
    // The confirmation repeats OUR name and address in its header. Give the
    // parser this deployment's identity so it skips those lines instead of
    // reading them as order lines -- it used to know one company's name.
    return normalizeBeatrizBallOrder(
      await parseBeatrizBallOrderPDF(buffer, await buyerIdentityLines()),
      entry,
    );
  }
  return null;
}

export default requirePermission(
  "admin.data",
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const formatId = typeof req.query.format === "string" ? req.query.format : "";
    const entry = HOME_ACCESSORY_FORMATS.find((f) => f.id === formatId);
    if (!entry) {
      return res.status(400).json({ error: `Unknown vendor format "${formatId}"` });
    }

    try {
      const form = createSecureForm(entry.accepts === "csv" ? "CSV_XLSX" : "PDF");
      const [, files] = await form.parse(req);
      const file = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const draft = await parseFor(entry, fs.readFileSync(file.filepath));
      if (!draft?.rows.length) {
        return res.status(400).json({ error: "No line items found in the uploaded file" });
      }
      return res.status(200).json(draft);
    } catch (err) {
      logError("Home accessory order preview parse failed", err);
      const message = err instanceof Error ? err.message : "Parse failed";
      return res.status(500).json({ error: message });
    }
  },
);
