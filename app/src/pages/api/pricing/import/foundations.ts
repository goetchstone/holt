// /app/src/pages/api/pricing/import/foundations.ts
//
// Imports Wesley Hall Foundations program pricing.
// Foundations products have a single cost (no grade tiers).
// Creates VendorStyle + StyleOptionOverrides (catalog templates) for
// per-style surcharges (Spring-Down Seat, CDC Seat/BDB Back, etc.)

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { foundationsImportSchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation/validate";
import { ValidationError } from "@/lib/apiHandler";
import { auditLog } from "@/lib/audit";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

interface FoundationsProductInput {
  styleNumber: string;
  description: string;
  styleName: string;
  foundationsCost: number;
  standardSeat: string | null;
  standardBack: string | null;
  springDownSeatSurcharge: number | null;
  springDownSeatIsStandard?: boolean;
  cdcSeatBdbBackSurcharge: number | null;
  cdcSeatBdbBackIsStandard?: boolean;
  decorativeFinishSurcharge: number | null;
  decorativeFinishIsStandard?: boolean;
  ringBaseSwivel: number | null;
  nailheadTrim: string | null;
  nailheadSurcharge?: number | null;
  nailheadIsStandard?: boolean;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    let validated: {
      vendorId: number;
      priceListName: string;
      effectiveDate: string;
      products: any[];
    };
    try {
      validated = validateBody(foundationsImportSchema, req.body) as typeof validated;
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message, details: err.details });
      }
      throw err;
    }
    const { vendorId, priceListName, effectiveDate, products } = validated;

    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) return res.status(404).json({ error: "Vendor not found" });

      // Default department + category
      const department = await prisma.department.upsert({
        where: { name: "Upholstery" },
        create: { name: "Upholstery" },
        update: {},
      });
      const category = await prisma.category.upsert({
        where: {
          name_departmentId: { name: "Upholstered Furniture", departmentId: department.id },
        },
        create: { name: "Upholstered Furniture", departmentId: department.id },
        update: {},
      });

      const result = await prisma.$transaction(async (tx) => {
        // Create/update Foundations price list
        const priceList = await tx.priceList.upsert({
          where: { vendorId_name: { vendorId, name: priceListName } },
          create: {
            vendorId,
            name: priceListName,
            effectiveDate: new Date(effectiveDate || Date.now()),
            priceType: "COST",
            isActive: true,
          },
          update: {
            effectiveDate: new Date(effectiveDate || Date.now()),
            isActive: true,
          },
        });

        // Create/update VendorProgram for Foundations
        const program = await tx.vendorProgram.upsert({
          where: { vendorId_name: { vendorId, name: "Foundations" } },
          create: {
            vendorId,
            name: "Foundations",
            description:
              "Wesley Hall Foundations program — simplified pricing with single cost per product.",
            isActive: true,
          },
          update: {},
        });

        // Note: We do NOT mark all VendorStyles as discontinued here because
        // Foundations is a subset program — it shouldn't affect the main wholesale styles.
        // Only the Foundations-specific styles are managed by this import.

        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        for (const p of products) {
          try {
            if (!p.styleNumber || !p.foundationsCost || p.foundationsCost <= 0) {
              skippedCount++;
              continue;
            }

            const styleName = p.styleName
              ? `${p.styleName} ${p.description}`.trim()
              : p.description || p.styleNumber;

            // ── VendorStyle (catalog template) ──────────────────────
            const vendorStyle = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: p.styleNumber, vendorId },
              },
              create: {
                styleNumber: p.styleNumber,
                name: styleName,
                description: p.description || null,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                baseCost: p.foundationsCost,
                standardSeat: p.standardSeat || null,
                standardBack: p.standardBack || null,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: styleName,
                description: p.description || undefined,
                baseCost: p.foundationsCost,
                standardSeat: p.standardSeat ?? undefined,
                standardBack: p.standardBack ?? undefined,
                isDiscontinued: false,
              },
            });

            // ─── Per-style option overrides ──────────────────────────
            async function upsertOptionOverride(
              groupName: string,
              optionName: string,
              surcharge: number,
              isStd: boolean,
              sort: number,
            ) {
              const group = await tx.vendorOptionGroup.upsert({
                where: { vendorId_name: { vendorId, name: groupName } },
                create: { vendorId, name: groupName },
                update: {},
              });
              const option = await tx.vendorOption.upsert({
                where: { groupId_name: { groupId: group.id, name: optionName } },
                create: {
                  groupId: group.id,
                  name: optionName,
                  surchargeType: "FLAT",
                  defaultSurcharge: surcharge,
                  sortOrder: sort,
                },
                update: {},
              });

              await tx.styleOptionOverride.upsert({
                where: {
                  vendorStyleId_optionId: { vendorStyleId: vendorStyle.id, optionId: option.id },
                },
                create: {
                  vendorStyleId: vendorStyle.id,
                  optionId: option.id,
                  surcharge,
                  isAvailable: true,
                  isStandard: isStd,
                },
                update: { surcharge, isAvailable: true, isStandard: isStd },
              });
            }

            // Spring-Down Seat
            if (
              (p.springDownSeatSurcharge && p.springDownSeatSurcharge > 0) ||
              p.springDownSeatIsStandard
            ) {
              await upsertOptionOverride(
                "Cushion Upgrade",
                "Spring-Down Seat",
                p.springDownSeatIsStandard ? 0 : p.springDownSeatSurcharge || 0,
                p.springDownSeatIsStandard ?? false,
                2,
              );
            }

            // CDC Seat / BDB Back
            if (
              (p.cdcSeatBdbBackSurcharge && p.cdcSeatBdbBackSurcharge > 0) ||
              p.cdcSeatBdbBackIsStandard
            ) {
              await upsertOptionOverride(
                "Cushion Upgrade",
                "CDC Seat / BDB Back",
                p.cdcSeatBdbBackIsStandard ? 0 : p.cdcSeatBdbBackSurcharge || 0,
                p.cdcSeatBdbBackIsStandard ?? false,
                3,
              );
            }

            // Decorative Finish
            if (
              (p.decorativeFinishSurcharge && p.decorativeFinishSurcharge > 0) ||
              p.decorativeFinishIsStandard
            ) {
              await upsertOptionOverride(
                "Decorative Finish",
                "Decorative Wood Finish",
                p.decorativeFinishIsStandard ? 0 : p.decorativeFinishSurcharge || 0,
                p.decorativeFinishIsStandard ?? false,
                0,
              );
            }

            // Ring Base Swivel
            if (p.ringBaseSwivel && p.ringBaseSwivel > 0) {
              await upsertOptionOverride(
                "Special Features",
                "Ring Base Swivel",
                p.ringBaseSwivel,
                false,
                0,
              );
            }

            // Nailhead Trim
            if ((p.nailheadSurcharge != null && p.nailheadSurcharge > 0) || p.nailheadIsStandard) {
              await upsertOptionOverride(
                "Nailhead Trim",
                "Nailhead Trim",
                p.nailheadIsStandard ? 0 : p.nailheadSurcharge || 0,
                p.nailheadIsStandard ?? false,
                0,
              );
            }

            importedCount++;
          } catch (err: unknown) {
            errors.push(`Style ${p.styleNumber}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        return {
          importedCount,
          skippedCount,
          errors,
          priceListId: priceList.id,
          programId: program.id,
        };
      }, TX_TIMEOUT.LONG);

      auditLog("IMPORT_FOUNDATIONS", (session.user as any)?.email || "unknown", {
        vendorId,
        priceListName,
        productCount: products.length,
      });

      return res.status(200).json({ success: true, ...result });
    } catch (error: unknown) {
      logError("Foundations import error", error);
      return res
        .status(500)
        .json({ error: "Import failed", details: getErrorMessage(error, "Import failed") });
    }
  },
);
