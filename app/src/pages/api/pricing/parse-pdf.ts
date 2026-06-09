// /app/src/pages/api/pricing/parse-pdf.ts
//
// Accepts a PDF file upload, extracts table data, and returns
// parsed rows as JSON for client-side preview before import.
// Supports multiple vendors via the "vendor" form field.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";
import fs from "fs";
import { createSecureForm } from "@/lib/secureUpload";
import { extractWholesalePricing, extractFabricCatalog } from "@/lib/pricing/pdfTableExtractor";
import { parseWholesaleRows, parseFoundationsRows } from "@/lib/pricing/wesleyHallParser";
import { parseSEPricing } from "@/lib/pricing/seParser";
import { extractCrLaineWholesale, extractCrLaineSimplicity } from "@/lib/pricing/crLaineExtractor";
import { extractGatCreekPricing } from "@/lib/pricing/gatCreekExtractor";
import { parseKingsleyBatePriceList } from "@/lib/pricing/kingsleyBateParser";
import { getErrorMessage } from "@/lib/toastError";

// Disable Next.js body parsing so formidable can handle the multipart upload
export const config = {
  api: { bodyParser: false },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const form = createSecureForm("PDF");
    const [fields, files] = await form.parse(req);

    const fileArray = files.file;
    if (!fileArray || fileArray.length === 0) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const uploadedFile = fileArray[0];
    const buffer = fs.readFileSync(uploadedFile.filepath);

    const vendor = Array.isArray(fields.vendor) ? fields.vendor[0] : fields.vendor || "wesley-hall";
    const type = Array.isArray(fields.type) ? fields.type[0] : fields.type || "wholesale";

    let parsedData: any[] = [];
    let diagnostics: any[] = [];
    let parseSummary: any = null;

    if (vendor === "brown-jordan") {
      const { parseBrownJordanPriceList } = await import("@/lib/pricing/brownJordanParser");
      const bjData = await parseBrownJordanPriceList(buffer);

      fs.unlinkSync(uploadedFile.filepath);

      return res.status(200).json({
        success: true,
        vendor,
        type: "retail-prices",
        count:
          bjData.seating.length +
          bjData.tables.length +
          bjData.fabrics.length +
          bjData.finishes.length,
        data: bjData,
      });
    } else if (vendor === "kingsley-bate") {
      const kbData = await parseKingsleyBatePriceList(buffer);
      const totalCount =
        kbData.frames.length +
        kbData.cushions.length +
        kbData.covers.length +
        kbData.fabrics.length;

      // Clean up temp file
      fs.unlinkSync(uploadedFile.filepath);

      return res.status(200).json({
        success: true,
        vendor,
        type: "retail-prices",
        count: totalCount,
        data: kbData,
      });
    } else if (vendor === "summer-classics") {
      const { parseSummerClassicsWholesale } = await import("@/lib/pricing/summerClassicsParser");
      const scData = await parseSummerClassicsWholesale(buffer);

      fs.unlinkSync(uploadedFile.filepath);

      return res.status(200).json({
        success: true,
        vendor,
        type: "wholesale",
        count: scData.products.length,
        data: scData,
      });
    } else if (vendor === "jensen-leisure") {
      const { parseJensenLeisureWholesale } = await import("@/lib/pricing/jensenLeisureParser");
      const jlData = await parseJensenLeisureWholesale(buffer);

      fs.unlinkSync(uploadedFile.filepath);

      return res.status(200).json({
        success: true,
        vendor,
        type: "wholesale",
        count: jlData.products.length,
        data: jlData,
      });
    } else if (vendor === "ekornes") {
      const { parseEkornesPriceList } = await import("@/lib/pricing/ekornesParser");
      const ekData = await parseEkornesPriceList(buffer);

      fs.unlinkSync(uploadedFile.filepath);

      return res.status(200).json({
        success: true,
        vendor,
        type: "retail-prices",
        count: ekData.products.length,
        data: ekData,
      });
    } else if (vendor === "american-leather") {
      const { extractAmericanLeather } = await import("@/lib/pricing/americanLeatherExtractor");
      const alData = await extractAmericanLeather(buffer);

      // Collect unique collection names
      const collections = [...new Set(alData.products.map((p) => p.collectionName))];

      fs.unlinkSync(uploadedFile.filepath);

      return res.status(200).json({
        success: true,
        vendor,
        type: alData.isRetail ? "retail-prices" : "wholesale",
        count: alData.products.length,
        data: {
          products: alData.products,
          pages: alData.pages,
          collections,
          effectiveDate: alData.effectiveDate,
          isRetail: alData.isRetail,
        },
      });
    } else if (vendor === "caperton" || vendor === "gat-creek") {
      parsedData = await extractGatCreekPricing(buffer);
    } else if (vendor === "c-r-laine" || vendor === "cr-laine") {
      if (type === "wholesale") {
        parsedData = await extractCrLaineWholesale(buffer);
      } else if (type === "simplicity") {
        parsedData = await extractCrLaineSimplicity(buffer);
      }
    } else {
      // Wesley Hall parsers (default)
      if (type === "wholesale") {
        const rawRows = await extractWholesalePricing(buffer);
        const parseResult = parseWholesaleRows(rawRows);
        parsedData = parseResult.data;
        diagnostics = parseResult.diagnostics;
        parseSummary = parseResult.summary;
      } else if (type === "foundations") {
        const rawRows = await extractWholesalePricing(buffer);
        const parseResult = parseFoundationsRows(rawRows);
        parsedData = parseResult.data;
        diagnostics = parseResult.diagnostics;
        parseSummary = parseResult.summary;
      } else if (type === "fabrics") {
        parsedData = await extractFabricCatalog(buffer);
      } else if (type === "signature-elements") {
        parsedData = await parseSEPricing(buffer);
      }
    }

    // Clean up temp file
    fs.unlinkSync(uploadedFile.filepath);

    return res.status(200).json({
      success: true,
      vendor,
      type,
      count: parsedData.length,
      data: parsedData,
      ...(diagnostics.length > 0 && { diagnostics }),
      ...(parseSummary && { summary: parseSummary }),
    });
  } catch (error: unknown) {
    return res.status(500).json({
      error: "Failed to parse PDF",
      details: getErrorMessage(error, "Internal server error"),
    });
  }
}
