// /app/src/pages/api/pricing/extract-images.ts
//
// POST /api/pricing/extract-images — Extract line drawing images from a
// wholesale PDF and update Product/VendorStyle records with imageUrl.
//
// This runs SEPARATELY from the main parse/import flow to avoid blocking
// the UI. The wholesale parse + import should happen first; then the user
// can click "Extract Images" to run this as a second pass.
//
// Supports multiple vendors: dispatches to the correct PDF parser based on
// vendor name. CR Laine products include page numbers for precise image
// mapping; Wesley Hall falls back to proportional distribution.
//
// Uses Poppler's `pdfimages` CLI for fast extraction (~2s for 100+ pages).

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { createSecureForm } from "@/lib/secureUpload";
import fs from "fs";
import path from "path";
import { extractPdfImages, savePageImages } from "@/lib/pricing/pdfImageExtractor";
import { logger, logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
import { extractWholesalePricing } from "@/lib/pricing/pdfTableExtractor";
import { parseWholesaleRows, type ParsedWholesaleProduct } from "@/lib/pricing/wesleyHallParser";
import { extractCrLaineWholesale } from "@/lib/pricing/crLaineExtractor";
import { extractGatCreekPricing } from "@/lib/pricing/gatCreekExtractor";

// Disable Next.js body parsing so formidable can handle multipart.
// externalResolver: true prevents Next.js from warning about long-running requests.
export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
    externalResolver: true,
  },
};

/** Check whether vendor name matches CR Laine (handles spelling variants). */
function isCrLaine(vendorName: string): boolean {
  const lower = vendorName.toLowerCase();
  return lower.includes("cr laine") || lower.includes("c r laine");
}

/** Check whether vendor name matches Gat Creek / Caperton. */
function isGatCreek(vendorName: string): boolean {
  const lower = vendorName.toLowerCase();
  return lower.includes("gat creek") || lower.includes("caperton");
}

/** Check whether vendor name matches Brown Jordan. */
function isBrownJordan(vendorName: string): boolean {
  return vendorName.toLowerCase().includes("brown jordan");
}

/** Check whether vendor name matches Summer Classics. */
function isSummerClassics(vendorName: string): boolean {
  return vendorName.toLowerCase().includes("summer classics");
}

/** Check whether vendor name matches Ekornes / Stressless. */
function isEkornes(vendorName: string): boolean {
  const lower = vendorName.toLowerCase();
  return lower.includes("ekornes") || lower.includes("stressless");
}

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

    const vendorIdStr = Array.isArray(fields.vendorId) ? fields.vendorId[0] : fields.vendorId;
    const vendorId = Number.parseInt(vendorIdStr || "", 10);
    if (Number.isNaN(vendorId)) {
      return res.status(400).json({ error: "vendorId is required" });
    }

    // Load vendor for slug
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, name: true },
    });
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const uploadedFile = fileArray[0];
    const buffer = fs.readFileSync(uploadedFile.filepath);

    // Step 1: Parse PDF to get products with style numbers (and page numbers
    // for vendors whose parsers track them).

    let parsedProducts: ParsedWholesaleProduct[];
    // SC cushion variants share a single frame drawing. This map tracks
    // which variant styleNumbers belong to each frameNumber so we can
    // propagate the extracted image URL to all variants after extraction.
    let frameToVariants: Map<string, string[]> | null = null;

    if (isSummerClassics(vendor.name)) {
      const { parseSummerClassicsWholesale } = await import("@/lib/pricing/summerClassicsParser");
      const scData = await parseSummerClassicsWholesale(buffer);

      frameToVariants = new Map<string, string[]>();
      const seenFrames = new Map<string, { pageNumber: number; description: string }>();

      for (const p of scData.products) {
        if (!seenFrames.has(p.frameNumber)) {
          seenFrames.set(p.frameNumber, {
            pageNumber: p.pageNumber,
            description: p.description,
          });
          frameToVariants.set(p.frameNumber, []);
        }
        if (p.styleNumber !== p.frameNumber) {
          frameToVariants.get(p.frameNumber)!.push(p.styleNumber);
        }
      }

      parsedProducts = Array.from(seenFrames.entries()).map(([frameNumber, info]) => ({
        styleNumber: frameNumber,
        description: info.description,
        styleName: info.description,
        pageNumber: info.pageNumber,
        gradePrices: [],
        leatherStyleNumber: null,
        finish: null,
        decorativeFinishSurcharge: null,
        standardPillows: null,
        gradeRiser: null,
        standardSeat: null,
        standardBack: null,
        springDownBdbSurcharge: null,
        comfortDownBdbSurcharge: null,
        yardagePlain: null,
        yardagePattern: null,
        yardageRepeat: null,
        overallWidth: null,
        overallDepth: null,
        overallHeight: null,
        seatHeight: null,
        armHeight: null,
        seatDepth: null,
      })) as ParsedWholesaleProduct[];
    } else if (isBrownJordan(vendor.name)) {
      const { parseBrownJordanPriceList } = await import("@/lib/pricing/brownJordanParser");
      const bjData = await parseBrownJordanPriceList(buffer);
      const allBjProducts = [...bjData.seating, ...bjData.tables];
      parsedProducts = allBjProducts.map((p) => ({
        styleNumber: p.styleNumber,
        description: p.description,
        styleName: p.description,
        pageNumber: p.pageNumber,
        gradePrices: [],
        leatherStyleNumber: null,
        finish: null,
        decorativeFinishSurcharge: null,
        standardPillows: null,
        gradeRiser: null,
        standardSeat: null,
        standardBack: null,
        springDownBdbSurcharge: null,
        comfortDownBdbSurcharge: null,
        yardagePlain: null,
        yardagePattern: null,
        yardageRepeat: null,
        overallWidth: null,
        overallDepth: null,
        overallHeight: null,
        seatHeight: null,
        armHeight: null,
        seatDepth: null,
      })) as ParsedWholesaleProduct[];
    } else if (isCrLaine(vendor.name)) {
      parsedProducts = await extractCrLaineWholesale(buffer);
    } else if (isGatCreek(vendor.name)) {
      const gatCreekProducts = await extractGatCreekPricing(buffer);
      parsedProducts = gatCreekProducts.map((p) => ({
        styleNumber: p.itemNumber,
        description: p.description,
        styleName: p.description,
        pageNumber: p.pageNumber ?? 0,
        gradePrices: [],
        leatherStyleNumber: null,
        finish: null,
        decorativeFinishSurcharge: null,
        standardPillows: null,
        gradeRiser: null,
        standardSeat: null,
        standardBack: null,
        springDownBdbSurcharge: null,
        comfortDownBdbSurcharge: null,
        yardagePlain: null,
        yardagePattern: null,
        yardageRepeat: null,
        overallWidth: null,
        overallDepth: null,
        overallHeight: null,
        seatHeight: null,
        armHeight: null,
        seatDepth: null,
      })) as ParsedWholesaleProduct[];
    } else if (isEkornes(vendor.name)) {
      const { parseEkornesPriceList } = await import("@/lib/pricing/ekornesParser");
      const ekData = await parseEkornesPriceList(buffer);
      parsedProducts = ekData.products.map((p) => ({
        styleNumber: p.materialNumber,
        description: p.description,
        styleName: p.description,
        pageNumber: p.pageNumber,
        gradePrices: [],
        leatherStyleNumber: null,
        finish: null,
        decorativeFinishSurcharge: null,
        standardPillows: null,
        gradeRiser: null,
        standardSeat: null,
        standardBack: null,
        springDownBdbSurcharge: null,
        comfortDownBdbSurcharge: null,
        yardagePlain: null,
        yardagePattern: null,
        yardageRepeat: null,
        overallWidth: null,
        overallDepth: null,
        overallHeight: null,
        seatHeight: null,
        armHeight: null,
        seatDepth: null,
      })) as ParsedWholesaleProduct[];
    } else {
      // Wesley Hall (default)
      const rawRows = await extractWholesalePricing(buffer);
      parsedProducts = parseWholesaleRows(rawRows).data;
    }

    if (parsedProducts.length === 0) {
      fs.unlinkSync(uploadedFile.filepath);
      return res.status(400).json({ error: "No products found in PDF" });
    }

    // Step 2: Build page→styles mapping so we can pass expected image counts
    const stylesByPage = new Map<number, string[]>();
    for (const product of parsedProducts) {
      if (product.pageNumber == null) continue;
      if (!stylesByPage.has(product.pageNumber)) {
        stylesByPage.set(product.pageNumber, []);
      }
      stylesByPage.get(product.pageNumber)!.push(product.styleNumber);
    }

    // Ekornes: each page has one main family image shared by all products.
    // Collapse to 1 representative style per page, then propagate after extraction.
    let ekornesPageStyles: Map<number, string[]> | null = null;
    if (isEkornes(vendor.name)) {
      ekornesPageStyles = new Map(stylesByPage);
      for (const [page, styles] of stylesByPage) {
        stylesByPage.set(page, [styles[0]]);
      }
    }

    const expectedCountByPage = new Map<number, number>();
    for (const [page, styles] of stylesByPage) {
      expectedCountByPage.set(page, styles.length);
    }

    // Step 3: Extract images via Poppler CLI (~2-5 seconds for 100+ pages)
    const { images, rawPageBase, diagnostics } = await extractPdfImages(
      buffer,
      expectedCountByPage,
    );

    // Clean up temp file
    fs.unlinkSync(uploadedFile.filepath);

    if (images.size === 0) {
      return res.json({
        success: true,
        imagesExtracted: 0,
        stylesUpdated: 0,
        pageNumberBase: rawPageBase,
        message: "No images found in PDF",
      });
    }

    // Step 4: Prepare output directory
    const vendorSlug = vendor.name.toLowerCase().replace(/\s+/g, "-");
    const outputDir = path.join(process.cwd(), "data", "uploads", "line-drawings", vendorSlug);

    // Skip images from pages before the first product page (intro content:
    // construction diagrams, upholstery guides, fabric charts, etc.)
    const productPages = Array.from(stylesByPage.keys());
    const firstProductPage = productPages.length > 0 ? Math.min(...productPages) : 1;
    for (const pageNum of images.keys()) {
      if (pageNum < firstProductPage) {
        images.delete(pageNum);
      }
    }

    // Count how many pages have both images and styles
    let pagesMatched = 0;
    for (const pageNum of images.keys()) {
      if (stylesByPage.has(pageNum)) pagesMatched++;
    }

    // Step 5: Save images and get style→URL mapping
    const totalImages = Array.from(images.values()).reduce((sum, arr) => sum + arr.length, 0);
    const imageMap = await savePageImages(images, outputDir, stylesByPage);

    // Step 6: Clear old image URLs so stale mappings don't persist
    await prisma.vendorStyle.updateMany({
      where: { vendorId },
      data: { imageUrl: null },
    });
    await prisma.product.updateMany({
      where: { vendorId },
      data: { imageUrl: null },
    });

    // Step 7: Update Product and VendorStyle records with new mappings
    let stylesUpdated = 0;
    for (const [styleNumber, imageUrl] of imageMap) {
      try {
        const styleResult = await prisma.vendorStyle.updateMany({
          where: { styleNumber, vendorId },
          data: { imageUrl },
        });

        const productResult = await prisma.product.updateMany({
          where: { productNumber: styleNumber, vendorId },
          data: { imageUrl },
        });

        stylesUpdated += styleResult.count + productResult.count;
      } catch (err) {
        logger.warn("extract-images: failed to update style", {
          styleNumber,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Ekornes: propagate the family image to all products on the same page.
    // The imageMap only contains the first style per page; the remaining
    // sibling styles need the same image URL.
    if (ekornesPageStyles) {
      for (const [page, allStyles] of ekornesPageStyles) {
        if (allStyles.length <= 1) continue;
        const representativeUrl = imageMap.get(allStyles[0]);
        if (!representativeUrl) continue;
        for (let i = 1; i < allStyles.length; i++) {
          const siblingStyle = allStyles[i];
          imageMap.set(siblingStyle, representativeUrl);
          try {
            const styleResult = await prisma.vendorStyle.updateMany({
              where: { styleNumber: siblingStyle, vendorId },
              data: { imageUrl: representativeUrl },
            });
            const productResult = await prisma.product.updateMany({
              where: { productNumber: siblingStyle, vendorId },
              data: { imageUrl: representativeUrl },
            });
            stylesUpdated += styleResult.count + productResult.count;
          } catch (err) {
            logger.warn("extract-images: failed to propagate image", {
              siblingStyle,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // SC: propagate frame image URLs to cushion variant VendorStyles.
    // The imageMap keys are frame numbers; variant VendorStyles use cushion
    // codes (e.g., C640) as their styleNumber but share the same drawing.
    if (frameToVariants) {
      for (const [frameNumber, imageUrl] of imageMap) {
        const variants = frameToVariants.get(frameNumber);
        if (!variants || variants.length === 0) continue;
        for (const variantStyleNumber of variants) {
          try {
            const result = await prisma.vendorStyle.updateMany({
              where: { styleNumber: variantStyleNumber, vendorId },
              data: { imageUrl },
            });
            stylesUpdated += result.count;
          } catch (err) {
            logger.warn("extract-images: failed to update SC variant", {
              variantStyleNumber,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // Build per-page diagnostics with style counts for debugging alignment
    const pageDiagnostics = diagnostics
      .filter((d) => d.pageNumber >= firstProductPage)
      .map((d) => ({
        ...d,
        styleCount: stylesByPage.get(d.pageNumber)?.length ?? 0,
        styles: stylesByPage.get(d.pageNumber) ?? [],
      }));

    // Build warnings for pages where image count doesn't match style count,
    // or where abnormally wide images suggest Poppler merged adjacent drawings
    const warnings: Array<{
      page: number;
      message: string;
      affectedStyles: string[];
      mergedImageDetected: boolean;
    }> = [];

    for (const diag of pageDiagnostics) {
      if (diag.styleCount === 0) continue;
      const finalImageCount = (images.get(diag.pageNumber) || []).length;
      const styles = diag.styles;

      // Detect abnormally wide images (>1.5x the median width on the page)
      let mergedImageDetected = false;
      const mergedPositions: number[] = [];
      if (diag.imageWidths.length > 1) {
        const sorted = [...diag.imageWidths].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (median > 0) {
          for (let i = 0; i < diag.imageWidths.length; i++) {
            if (diag.imageWidths[i] > median * 1.5) {
              mergedImageDetected = true;
              mergedPositions.push(i);
            }
          }
        }
      }

      if (finalImageCount < diag.styleCount) {
        // Fewer images than styles: some products will have incorrect or missing images
        const deficit = diag.styleCount - finalImageCount;
        const affected =
          deficit >= diag.styleCount ? styles : styles.slice(finalImageCount - deficit);

        let message = `Page ${diag.pageNumber}: Expected ${diag.styleCount} images, found ${finalImageCount}.`;
        if (mergedImageDetected) {
          message += ` Likely merged image at position${mergedPositions.length > 1 ? "s" : ""} ${mergedPositions.map((p) => p + 1).join(", ")}.`;
        }
        message += ` Styles ${affected.join(", ")} may have incorrect images.`;

        warnings.push({
          page: diag.pageNumber,
          message,
          affectedStyles: affected,
          mergedImageDetected,
        });
      } else if (mergedImageDetected) {
        // Image count matches but a wide image suggests a merge compensated
        // by filtering -- flag it so the user can verify
        const affected = mergedPositions.flatMap((pos) => {
          const nearby = [styles[pos], styles[pos + 1]].filter(Boolean);
          return nearby;
        });
        const unique = [...new Set(affected)];

        warnings.push({
          page: diag.pageNumber,
          message:
            `Page ${diag.pageNumber}: Abnormally wide image detected at position${mergedPositions.length > 1 ? "s" : ""} ` +
            `${mergedPositions.map((p) => p + 1).join(", ")}. Styles ${unique.join(", ")} may need verification.`,
          affectedStyles: unique,
          mergedImageDetected: true,
        });
      }
    }

    return res.json({
      success: true,
      imagesExtracted: totalImages,
      pagesWithImages: images.size,
      pageNumberBase: rawPageBase,
      pagesMatched,
      stylesMapped: imageMap.size,
      stylesUpdated,
      warnings,
      diagnostics: pageDiagnostics,
    });
  } catch (error: unknown) {
    logError("extract-images failed", error);
    return res.status(500).json({
      error: "Image extraction failed",
      details: getErrorMessage(error, "Internal server error"),
      stack:
        process.env.NODE_ENV === "development" && error instanceof Error ? error.stack : undefined,
    });
  }
}
