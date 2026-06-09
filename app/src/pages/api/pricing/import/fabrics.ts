// /app/src/pages/api/pricing/import/fabrics.ts
//
// POST /api/pricing/import/fabrics — bulk import fabric catalog data
//
// Accepts an array of fabric rows (parsed client-side from CSV/XLSX).
// Each row needs at least: fabricName, grade (to map to tier).
// Matches grade codes to existing PriceDimensionTier records for the vendor.

import { getErrorMessage } from "@/lib/toastError";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { fabricImportSchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation/validate";
import { ValidationError } from "@/lib/apiHandler";
import { auditLog } from "@/lib/audit";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
// Increase body size limit for large fabric catalogs
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

interface FabricRow {
  fabricName: string;
  fabricCode?: string;
  grade: string; // Must match a PriceDimensionTier.code (e.g., "14", "20", "COM")
  colorName?: string;
  colorCode?: string;
  patternRepeat?: string;
  width?: string;
  content?: string; // Fiber content
  collection?: string;
  usage?: string;
  notes?: string;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    let validated: { vendorId: number; fabrics: any[]; clearExisting?: boolean };
    try {
      validated = validateBody(fabricImportSchema, req.body) as typeof validated;
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        return res
          .status(400)
          .json({ error: getErrorMessage(err, "Unknown error"), details: err.details });
      }
      throw err;
    }
    const { vendorId, fabrics, clearExisting } = validated;

    try {
      // Verify vendor exists
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      // Load all dimension tiers for this vendor, keyed by code
      const dimensions = await prisma.vendorPriceDimension.findMany({
        where: { vendorId },
        include: { tiers: true },
      });

      // Build a map of tier code → tier ID (case-insensitive)
      const tierMap: Record<string, number> = {};
      for (const dim of dimensions) {
        for (const tier of dim.tiers) {
          tierMap[tier.code.toLowerCase()] = tier.id;
          // Also map by display name (e.g., "Grade 14" → 14)
          tierMap[tier.name.toLowerCase()] = tier.id;
        }
      }

      // Note: we no longer require tiers to pre-exist. If a grade code is not found,
      // we auto-create the tier on the appropriate dimension (Fabric Grade for numeric,
      // Leather Grade for single-letter codes). This makes the fabric import self-sufficient
      // — the wholesale price book only creates tiers up to ~grade 60, but fabrics can
      // have grades well beyond that (97, 102, 136, 196, 211, etc.)

      const result = await prisma.$transaction(async (tx) => {
        // Optionally clear existing fabric catalog for this vendor
        if (clearExisting) {
          await tx.fabricCatalog.deleteMany({ where: { vendorId } });
        }

        let created = 0;
        const updated = 0;
        let skipped = 0;
        const errors: string[] = [];
        const unmatchedGrades = new Set<string>();
        const autoCreatedTiers: string[] = [];

        for (let i = 0; i < fabrics.length; i++) {
          const row = fabrics[i];

          if (!row.fabricName?.trim()) {
            skipped++;
            continue;
          }

          // Resolve grade to tier ID
          const gradeKey = String(row.grade || "")
            .trim()
            .toLowerCase();
          let tierId = tierMap[gradeKey];

          // Try common aliases: "grade 14" → "14", "gr. 14" → "14"
          if (!tierId) {
            const cleaned = gradeKey
              .replace(/^grade\s*/i, "")
              .replace(/^gr\.?\s*/i, "")
              .trim();
            tierId = tierMap[cleaned];
          }

          // Auto-create missing tier if grade code is valid
          if (!tierId) {
            const rawCode = String(row.grade).trim();
            const isNumeric = /^\d+$/.test(rawCode);
            const isLetterGrade = /^[A-Z]$/i.test(rawCode);

            if (isNumeric || isLetterGrade) {
              // Determine dimension type: single letter = leather, numeric = fabric
              const dimName = isLetterGrade ? "Leather Grade" : "Fabric Grade";
              const dimType = isLetterGrade
                ? ("LEATHER_GRADE" as const)
                : ("FABRIC_GRADE" as const);

              // Find or create the dimension
              const dimension = await tx.vendorPriceDimension.upsert({
                where: { vendorId_name: { vendorId, name: dimName } },
                create: { vendorId, name: dimName, dimensionType: dimType },
                update: {},
              });

              // Create the tier
              const code = rawCode.toUpperCase();
              const tierName = isLetterGrade ? `Grade ${code}` : `Grade ${rawCode}`;
              const sortOrder = isNumeric ? Number.parseInt(rawCode) : rawCode.charCodeAt(0);

              const newTier = await tx.priceDimensionTier.upsert({
                where: { dimensionId_code: { dimensionId: dimension.id, code } },
                create: {
                  dimensionId: dimension.id,
                  code,
                  name: tierName,
                  sortOrder,
                },
                update: {},
              });

              tierId = newTier.id;
              tierMap[gradeKey] = tierId;
              tierMap[code.toLowerCase()] = tierId;
              autoCreatedTiers.push(code);
            }
          }

          if (!tierId) {
            unmatchedGrades.add(String(row.grade));
            errors.push(
              `Row ${i + 1}: Unknown grade "${row.grade}" for fabric "${row.fabricName}"`,
            );
            skipped++;
            continue;
          }

          try {
            // Upsert by vendor + fabricName + colorName
            const fabricNameClean = row.fabricName.trim();
            const colorNameClean = (row.colorName || "").trim() || "";

            await tx.fabricCatalog.upsert({
              where: {
                vendorId_fabricName_colorName: {
                  vendorId,
                  fabricName: fabricNameClean,
                  colorName: colorNameClean,
                },
              },
              create: {
                vendorId,
                tierId,
                fabricName: fabricNameClean,
                fabricCode: row.fabricCode?.trim() || null,
                colorName: colorNameClean,
                colorCode: row.colorCode?.trim() || null,
                patternRepeat: row.patternRepeat?.trim() || null,
                width: row.width?.trim() || null,
                content: row.content?.trim() || null,
                collection: row.collection?.trim() || null,
                usage: row.usage?.trim() || null,
                notes: row.notes?.trim() || null,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                tierId,
                fabricCode: row.fabricCode?.trim() || undefined,
                colorCode: row.colorCode?.trim() || undefined,
                patternRepeat: row.patternRepeat?.trim() || undefined,
                width: row.width?.trim() || undefined,
                content: row.content?.trim() || undefined,
                collection: row.collection?.trim() || undefined,
                usage: row.usage?.trim() || undefined,
                notes: row.notes?.trim() || undefined,
                isActive: true,
                isDiscontinued: false,
              },
            });
            created++;
          } catch (err: unknown) {
            errors.push(`Row ${i + 1}: ${getErrorMessage(err, "Unknown error")}`);
            skipped++;
          }
        }

        return {
          created,
          updated,
          skipped,
          errors: errors.slice(0, 50),
          totalErrors: errors.length,
          unmatchedGrades: Array.from(unmatchedGrades),
          autoCreatedTiers,
        };
      }, TX_TIMEOUT.LONG);

      auditLog("IMPORT_FABRICS", (session.user as any)?.email || "unknown", {
        vendorId,
        fabricCount: fabrics.length,
        clearExisting: !!clearExisting,
      });

      return res.json({
        success: true,
        ...result,
        availableGrades: Object.keys(tierMap)
          .filter((k) => /^\d+$/.test(k) || /^[a-z]{1,3}$/i.test(k))
          .map((k) => k.toUpperCase())
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .sort((a, b) => a.localeCompare(b)),
      });
    } catch (error: unknown) {
      logError("Fabric import error", error);
      return res.status(500).json({
        error: "Import failed",
        details: getErrorMessage(error, "Unknown error"),
      });
    }
  },
);
