// /app/src/pages/api/pricing/import/summer-classics-prices.ts
//
// Imports Summer Classics wholesale pricing data.
// Creates/updates: PriceList, Collections, VendorPriceDimension (Cushion Fabric Grade),
// PriceDimensionTier (A/B/C/D), VendorStyle, StyleGradePrice in a single transaction.
//
// Receives pre-parsed data from the client (parsed by parseSummerClassicsWholesale
// via parse-pdf.ts) as JSON.

import { getErrorMessage } from "@/lib/toastError";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import type { SurchargeType } from "@prisma/client";
import type { ParsedSCProduct, ParsedSCCollection } from "@/lib/pricing/summerClassicsParser";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

// ─── Cushion fabric grade tiers ──────────────────────────────────

const CUSHION_GRADE_TIERS = [
  { code: "A", name: "Grade A", sort: 0 },
  { code: "B", name: "Grade B", sort: 1 },
  { code: "C", name: "Grade C", sort: 2 },
  { code: "D", name: "Grade D", sort: 3 },
];

// ─── Vendor option seeds ─────────────────────────────────────────

interface OptionSeedDef {
  groupName: string;
  description: string;
  options: {
    name: string;
    surchargeType: SurchargeType;
    surcharge: number;
    sort: number;
  }[];
}

const SC_OPTION_SEEDS: OptionSeedDef[] = [
  {
    groupName: "Cushion Fill",
    description: "Cushion fill options (Standard foam vs Dream down-blend)",
    options: [
      { name: "Standard", surchargeType: "FLAT", surcharge: 0, sort: 0 },
      { name: "Dream", surchargeType: "FLAT", surcharge: 0, sort: 1 },
    ],
  },
  {
    groupName: "Welt",
    description: "Welting options",
    options: [
      { name: "No Welt", surchargeType: "FLAT", surcharge: 0, sort: 0 },
      { name: "With Welt", surchargeType: "FLAT", surcharge: 0, sort: 1 },
    ],
  },
];

async function seedSCOptions(vendorId: number) {
  for (const groupDef of SC_OPTION_SEEDS) {
    const group = await prisma.vendorOptionGroup.upsert({
      where: { vendorId_name: { vendorId, name: groupDef.groupName } },
      create: { vendorId, name: groupDef.groupName, description: groupDef.description },
      update: {},
    });
    for (const opt of groupDef.options) {
      await prisma.vendorOption.upsert({
        where: { groupId_name: { groupId: group.id, name: opt.name } },
        create: {
          groupId: group.id,
          name: opt.name,
          surchargeType: opt.surchargeType,
          defaultSurcharge: opt.surcharge,
          sortOrder: opt.sort,
        },
        update: {},
      });
    }
  }
}

// ─── Handler ─────────────────────────────────────────────────────

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { vendorId, priceListName, effectiveDate, products } = req.body as {
      vendorId: number;
      priceListName: string;
      effectiveDate: string;
      products: {
        products: ParsedSCProduct[];
        collections: ParsedSCCollection[];
      };
    };

    if (!vendorId || !priceListName || !products) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { products: scProducts, collections: scCollections } = products;
    if (scProducts.length === 0) {
      return res.status(400).json({ error: "No products to import" });
    }

    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      // Department + category for outdoor furniture
      const department = await prisma.department.upsert({
        where: { name: "Outdoor" },
        create: { name: "Outdoor" },
        update: {},
      });

      const category = await prisma.category.upsert({
        where: {
          name_departmentId: { name: "Outdoor Furniture", departmentId: department.id },
        },
        create: { name: "Outdoor Furniture", departmentId: department.id },
        update: {},
      });

      // Seed vendor-level options
      await seedSCOptions(vendorId);

      const result = await prisma.$transaction(async (tx) => {
        // 1. Create/update PriceList
        const priceList = await tx.priceList.upsert({
          where: {
            vendorId_name: { vendorId, name: priceListName },
          },
          create: {
            vendorId,
            name: priceListName,
            effectiveDate: new Date(effectiveDate),
            priceType: "WHOLESALE",
            isActive: true,
          },
          update: {
            effectiveDate: new Date(effectiveDate),
            isActive: true,
          },
        });

        // 2. Create Cushion Fabric Grade dimension + tiers
        const dimension = await tx.vendorPriceDimension.upsert({
          where: { vendorId_name: { vendorId, name: "Cushion Fabric Grade" } },
          create: {
            vendorId,
            name: "Cushion Fabric Grade",
            dimensionType: "FABRIC_GRADE",
          },
          update: {},
        });

        const tierMap: Record<string, number> = {};
        for (const tier of CUSHION_GRADE_TIERS) {
          const t = await tx.priceDimensionTier.upsert({
            where: {
              dimensionId_code: { dimensionId: dimension.id, code: tier.code },
            },
            create: {
              dimensionId: dimension.id,
              code: tier.code,
              name: tier.name,
              sortOrder: tier.sort,
            },
            update: { sortOrder: tier.sort },
          });
          tierMap[tier.code] = t.id;
        }

        // 3. Create Collections
        const collectionFinishMap = new Map<string, string>();
        for (const coll of scCollections) {
          collectionFinishMap.set(coll.name, coll.availableFinishes);
        }

        const collectionNames = new Set(scProducts.map((p) => p.collection).filter(Boolean));
        const collectionIdMap: Record<string, number> = {};
        for (const name of Array.from(collectionNames)) {
          const collection = await tx.collection.upsert({
            where: { vendorId_name: { vendorId, name } },
            create: { vendorId, name },
            update: {},
          });
          collectionIdMap[name] = collection.id;
        }

        // 4. Mark existing VendorStyles as discontinued
        await tx.vendorStyle.updateMany({
          where: { vendorId },
          data: { isDiscontinued: true },
        });

        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        // 5. Import products
        for (const p of scProducts) {
          try {
            if (!p.styleNumber) {
              skippedCount++;
              continue;
            }

            const isCushioned = p.gradePrices.length > 0;
            const baseCost = isCushioned ? p.gradePrices[0].cost : p.framePrice;
            const finishStr = collectionFinishMap.get(p.collection) || null;
            const descSuffix = p.cushionType ? ` - ${p.cushionType}` : "";

            const style = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: p.styleNumber, vendorId },
              },
              create: {
                styleNumber: p.styleNumber,
                name: p.description + descSuffix,
                description: p.cushionType || null,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                collectionId: collectionIdMap[p.collection] || null,
                framePrice: p.framePrice,
                baseCost,
                finish: finishStr,
                width: p.width || null,
                depth: p.depth || null,
                height: p.height || null,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: p.description + descSuffix,
                description: p.cushionType || undefined,
                collectionId: collectionIdMap[p.collection] || undefined,
                framePrice: p.framePrice,
                baseCost,
                finish: finishStr || undefined,
                width: p.width ?? undefined,
                depth: p.depth ?? undefined,
                height: p.height ?? undefined,
                isDiscontinued: false,
              },
            });

            // Create grade prices for cushioned products
            for (const gp of p.gradePrices) {
              const tierId = tierMap[gp.grade];
              if (!tierId) continue;
              await tx.styleGradePrice.upsert({
                where: {
                  vendorStyleId_tierId: { vendorStyleId: style.id, tierId },
                },
                create: { vendorStyleId: style.id, tierId, cost: gp.cost },
                update: { cost: gp.cost },
              });
            }

            importedCount++;
          } catch (err: unknown) {
            const msg = err instanceof Error ? getErrorMessage(err, "Unknown error") : String(err);
            errors.push(`${p.styleNumber}: ${msg}`);
            skippedCount++;
          }
        }

        return { importedCount, skippedCount, errors, priceListId: priceList.id };
      }, TX_TIMEOUT.LONG);

      return res.status(200).json({
        success: true,
        ...result,
        collectionsCreated: Object.keys(
          scProducts.reduce(
            (acc, p) => {
              acc[p.collection] = true;
              return acc;
            },
            {} as Record<string, boolean>,
          ),
        ).length,
      });
    } catch (error: unknown) {
      return res.status(500).json({
        error: "Import failed",
        details: getErrorMessage(error, "Unknown error"),
      });
    }
  },
);
