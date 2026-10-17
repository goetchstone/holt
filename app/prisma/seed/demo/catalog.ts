// app/prisma/seed/demo/catalog.ts
//
// Department -> Category -> Type taxonomy, Vendors (invented furniture-
// trade names, never real manufacturers), and Products carrying BOTH cost
// and retail (margin reporting needs cost — see docs/domains/reporting.md).
//
// Product prices are catalog "list" data only; actual order economics come
// from the independently-sampled order-value distribution in
// salesOrders.ts (real POS tickets rarely equal a straight sum of list
// prices once discounts/configuration are involved), so nothing here needs
// to reconcile against order totals.

import type { PrismaClient } from "@prisma/client";
import type { Rng } from "./rng";
import { pick, randFloat, randInt, round2 } from "./rng";
import { CATEGORIES_BY_DEPARTMENT, DEPARTMENTS } from "./catalogTaxonomy";
import { VENDOR_NAMES } from "./names";

const SEED_ACTOR = "seed:demo";

const PRICE_RANGE_BY_DEPARTMENT: Record<string, [number, number]> = {
  "Living Room": [400, 4500],
  Bedroom: [300, 3200],
  Dining: [250, 3800],
  Rugs: [90, 4500],
  Outdoor: [200, 3200],
  Lighting: [60, 900],
  "Accessories & Decor": [25, 650],
  Mattresses: [350, 3200],
};

const NAME_PREFIXES = [
  "Bristol",
  "Kendall",
  "Ashford",
  "Somerset",
  "Wexford",
  "Calloway",
  "Brookline",
  "Hartwell",
  "Sutton",
  "Camden",
  "Dorset",
  "Fenwick",
  "Talbridge",
  "Winslow",
  "Avondale",
  "Prescott",
  "Rosemont",
  "Thackery",
  "Linden",
  "Marlowe",
  "Sheffield",
  "Colville",
  "Hadleigh",
  "Windermere",
] as const;

function vendorCode(name: string, taken: Set<string>): string {
  const letters = name
    .split(/\s+/)
    .filter((w) => !/^(the|of|&|co\.?|and)$/i.test(w))
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 4);
  let code = letters || "VEN";
  let n = 2;
  while (taken.has(code)) {
    code = `${letters}${n}`;
    n += 1;
  }
  taken.add(code);
  return code;
}

/**
 * Each vendor's standard lead time in days (Vendor.leadTimeDays), by what it
 * makes: custom upholstery and leather run ten to twelve weeks, case goods six
 * to nine, lighting, rugs and textiles three to four, mattresses two.
 *
 * One vendor is null on purpose -- a vendor recently set up, whose lead time
 * nobody has entered. Its POs carry no expected date ("No ESD" on the Delivery
 * Planner), the row a buyer has to chase. Every PO date in the seed is derived
 * from these (purchasing.ts, orderPlan.ts), never drawn at random.
 */
export const VENDOR_LEAD_TIME_DAYS: Record<(typeof VENDOR_NAMES)[number], number | null> = {
  "Northshore Casegoods Co.": 56,
  "Amberlin Upholstery Works": 77,
  "Foundry Row Furniture": 49,
  "Wickfield Home Collections": 28,
  "Cobblestone Leather Guild": 84,
  "Harborview Case & Frame": 63,
  "Millpond Textile Mills": 28,
  "Cedar Hollow Woodworks": 56,
  "Larkspur Lighting Studio": 21,
  "Bramblewood Outdoor Living": 35,
  "Saltmarsh Metalcraft": 28,
  "Quarry Hill Casegoods": 42,
  "Fieldstone Mattress Co.": 14,
  "Anchor & Ash Furniture": null,
  "Coppermine Rug Traders": 21,
};

/** How long goods really take when the vendor's lead time is not on file --
 *  the seed has to deliver those orders on SOME date. Never written anywhere. */
export const UNKNOWN_VENDOR_ACTUAL_LEAD_DAYS = 45;

export interface CatalogProduct {
  id: number;
  productNumber: string;
  name: string;
  vendorId: number;
  /** The vendor's standard lead time as recorded; null when not on file. */
  vendorLeadTimeDays: number | null;
  departmentId: number;
  categoryId: number;
  typeId: number;
  departmentName: string;
  baseCost: number;
  baseRetail: number;
}

export interface CatalogSetup {
  departmentIdByName: Map<string, number>;
  vendorIds: number[];
  /** Vendor id -> standard lead time in days, null when not on file. */
  leadTimeByVendorId: Map<number, number | null>;
  products: CatalogProduct[];
}

export async function seedCatalog(
  prisma: PrismaClient,
  rng: Rng,
  accountGroupIdByDepartment: Map<string, number>,
  productCount: number,
): Promise<CatalogSetup> {
  // --- Departments / Categories / Types --------------------------------
  const departmentIdByName = new Map<string, number>();
  const categoryIdByKey = new Map<string, number>(); // `${dept}::${category}`
  const typeIdByKey = new Map<string, number>(); // `${dept}::${category}::${type}`

  for (const dept of DEPARTMENTS) {
    // Reporting roles are written on update too, not just create. The demo seed
    // owns this database (prisma/seed/demo/guard.ts refuses anything else), and
    // a clone seeded before these columns existed would otherwise keep the
    // migration's backfilled values -- which reproduce the OLD hardcoded
    // taxonomy, the thing these columns exist to replace.
    const reportRoles = {
      reportGroup: dept.reportGroup ?? null,
      crossSellTarget: dept.crossSellTarget ?? false,
      crossSellAnchor: dept.crossSellAnchor ?? false,
    };
    const row = await prisma.department.upsert({
      where: { name: dept.name },
      update: reportRoles,
      create: { name: dept.name, createdBy: SEED_ACTOR, ...reportRoles },
    });
    departmentIdByName.set(dept.name, row.id);

    const accountGroupId = accountGroupIdByDepartment.get(dept.name) ?? null;
    for (const cat of CATEGORIES_BY_DEPARTMENT[dept.name] ?? []) {
      const catRow = await prisma.category.upsert({
        where: { name_departmentId: { name: cat.name, departmentId: row.id } },
        update: { accountGroupId },
        create: {
          name: cat.name,
          departmentId: row.id,
          accountGroupId,
          createdBy: SEED_ACTOR,
        },
      });
      categoryIdByKey.set(`${dept.name}::${cat.name}`, catRow.id);

      for (const typeName of cat.types) {
        const typeRow = await prisma.type.upsert({
          where: { name_categoryId: { name: typeName, categoryId: catRow.id } },
          update: {},
          create: { name: typeName, categoryId: catRow.id, createdBy: SEED_ACTOR },
        });
        typeIdByKey.set(`${dept.name}::${cat.name}::${typeName}`, typeRow.id);
      }
    }
  }

  // --- Vendors -----------------------------------------------------------
  const takenCodes = new Set<string>();
  const vendorIds: number[] = [];
  const leadTimeByVendorId = new Map<number, number | null>();
  for (const name of VENDOR_NAMES) {
    const code = vendorCode(name, takenCodes);
    const town = pick(rng, [
      { city: "High Point", state: "NC" },
      { city: "Hickory", state: "NC" },
      { city: "Tupelo", state: "MS" },
      { city: "Grand Rapids", state: "MI" },
      { city: "Martinsville", state: "VA" },
    ]);
    const vendor = await prisma.vendor.upsert({
      where: { name },
      update: {},
      create: {
        name,
        code,
        pricingModel: "FLAT",
        accountNumber: `ACC-${randInt(rng, 10000, 99999)}`,
        paymentTerms: pick(rng, ["Net 30", "Net 45", "Net 60", "2/10 Net 30"]),
        freightTerms: pick(rng, ["FOB Factory", "FOB Destination", "Prepaid & Add"]),
        city: town.city,
        state: town.state,
        phone: `(${randInt(rng, 200, 989)}) 555-${String(randInt(rng, 0, 9999)).padStart(4, "0")}`,
        email: `orders@${code.toLowerCase()}.example.com`,
        leadTimeDays: VENDOR_LEAD_TIME_DAYS[name],
        createdBy: SEED_ACTOR,
      },
    });
    vendorIds.push(vendor.id);
    leadTimeByVendorId.set(vendor.id, VENDOR_LEAD_TIME_DAYS[name]);
  }

  // --- Products ------------------------------------------------------
  // Cycle through every (department, category, type) combination,
  // round-robining vendors, until `productCount` is reached.
  const combos: { deptName: string; catName: string; typeName: string }[] = [];
  for (const dept of DEPARTMENTS) {
    for (const cat of CATEGORIES_BY_DEPARTMENT[dept.name] ?? []) {
      for (const typeName of cat.types) {
        combos.push({ deptName: dept.name, catName: cat.name, typeName });
      }
    }
  }

  const products: CatalogProduct[] = [];
  let productNumberSeq = 1000;
  for (let i = 0; i < productCount; i++) {
    const combo = combos[i % combos.length];
    const vendorId = vendorIds[randInt(rng, 0, vendorIds.length - 1)];
    const [lo, hi] = PRICE_RANGE_BY_DEPARTMENT[combo.deptName] ?? [100, 1000];
    // Log-space draw so the department's price range skews toward the
    // lower/mid end with occasional premium pieces, like a real catalog.
    const logLo = Math.log(lo);
    const logHi = Math.log(hi);
    const baseRetail = round2(Math.exp(randFloat(rng, logLo, logHi)));
    const marginFactor = randFloat(rng, 0.35, 0.55); // cost as a fraction of retail
    const baseCost = round2(baseRetail * marginFactor);

    productNumberSeq += 1;
    const name = `${pick(rng, NAME_PREFIXES)} ${combo.typeName}`;
    const productNumber = `${productNumberSeq}`;

    const product = await prisma.product.create({
      data: {
        productNumber,
        name,
        vendorId,
        departmentId: departmentIdByName.get(combo.deptName)!,
        categoryId: categoryIdByKey.get(`${combo.deptName}::${combo.catName}`)!,
        typeId: typeIdByKey.get(`${combo.deptName}::${combo.catName}::${combo.typeName}`)!,
        baseCost,
        baseRetail,
        isActive: true,
        createdBy: SEED_ACTOR,
      },
    });

    products.push({
      id: product.id,
      productNumber: product.productNumber,
      name: product.name,
      vendorId,
      vendorLeadTimeDays: leadTimeByVendorId.get(vendorId) ?? null,
      departmentId: departmentIdByName.get(combo.deptName)!,
      categoryId: categoryIdByKey.get(`${combo.deptName}::${combo.catName}`)!,
      typeId: typeIdByKey.get(`${combo.deptName}::${combo.catName}::${combo.typeName}`)!,
      departmentName: combo.deptName,
      baseCost,
      baseRetail,
    });
  }

  return { departmentIdByName, vendorIds, leadTimeByVendorId, products };
}
