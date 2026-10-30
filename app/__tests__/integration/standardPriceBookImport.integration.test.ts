// /app/__tests__/integration/standardPriceBookImport.integration.test.ts
//
// A vendor with no parser of its own imports its book through the standard
// layout (lib/pricing/standardPriceBook.ts): parsed as the import screen
// parses it, posted through the real route handler, written by
// lib/pricing/importWholesaleBook.ts. And a flat catalog with case packs
// through the generic product import. Real database; every price INVENTED.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import { readFileSync } from "fs";
import { join } from "path";
import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  parseStandardPriceBookCsv,
  parseStandardPriceBookRows,
} from "@/lib/pricing/standardPriceBook";
import { handler as wholesaleImport } from "@/pages/api/pricing/import/wholesale-prices";
import { runGenericImport } from "@/lib/genericImportRunner";
import { getImportEntity, suggestMapping } from "@/lib/genericImport";

const adminSession = { user: { email: "admin@store.com" } } as unknown as Session;
const BOOKS = join(__dirname, "../../prisma/seed/demo/pricebooks");

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    setHeader() {},
  };
  return res;
}

async function importBook(vendorId: number, products: unknown[]) {
  const res = makeRes();
  const req = {
    method: "POST",
    query: {},
    cookies: {},
    body: {
      vendorId,
      priceListName: "Wholesale",
      mode: "renew",
      sourceBook: "wholesale",
      products,
    },
  } as unknown as NextApiRequest;
  await wholesaleImport(req, res as unknown as NextApiResponse, adminSession);
  return res;
}

async function vendorNamed(name: string) {
  return prisma.vendor.create({ data: { name, pricingModel: "FLAT" } });
}

describe("standard price-book layout (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("imports any vendor's book: every style, its declared grades and its options", async () => {
    const vendor = await vendorNamed("Some New Upholsterer");
    const book = parseStandardPriceBookCsv(
      readFileSync(join(BOOKS, "pellwood-custom-upholstery.csv"), "utf8"),
    );
    const res = await importBook(vendor.id, book.data);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, importedCount: 18, skippedCount: 0 });

    const sofa = await prisma.vendorStyle.findFirstOrThrow({
      where: { vendorId: vendor.id, styleNumber: "PU-2100-S" },
      include: {
        gradePrices: { include: { tier: { include: { dimension: true } } } },
        optionOverrides: { include: { option: { include: { group: true } } } },
      },
    });
    const cost = (code: string) => sofa.gradePrices.find((g) => g.tier.code === code);
    expect(Number(cost("14")?.cost)).toBe(1320);
    expect(cost("14")?.tier.dimension.dimensionType).toBe("FABRIC_GRADE");
    expect(Number(cost("COM")?.cost)).toBe(1050);
    expect(Number(sofa.comYardage)).toBe(14);

    const opt = (name: string) => sofa.optionOverrides.find((o) => o.option.name === name);
    expect(opt("Antique Brass")).toMatchObject({ isStandard: true, isAvailable: true });
    expect(opt("Kick Pleat")).toMatchObject({ isAvailable: false });
    expect(Number(opt("Premium Finish")?.surcharge)).toBe(85);
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).pricingModel).toBe(
      "GRADE_BASED",
    );
  });

  it("files a letter grade as the book declares it, not as its shape suggests", async () => {
    // A bare letter is leather to the shape guess (importWholesaleBook
    // partitionGrades); this vendor ladders FABRIC by letter and says so.
    const vendor = await vendorNamed("Letter Ladder Fabrics");
    const book = parseStandardPriceBookRows([
      {
        "Style #": "L-1",
        "Style Name": "Chair",
        Description: "Chair",
        "Fabric B": "500",
        "Fabric C": "540",
      },
    ]);
    expect((await importBook(vendor.id, book.data)).statusCode).toBe(200);

    const tiers = await prisma.priceDimensionTier.findMany({
      where: { code: { in: ["B", "C"] }, dimension: { vendorId: vendor.id } },
      include: { dimension: true },
    });
    expect(tiers.map((t) => t.dimension.dimensionType)).toEqual(["FABRIC_GRADE", "FABRIC_GRADE"]);
  });

  it("refuses a book that declares one grade as both fabric and leather", async () => {
    const vendor = await vendorNamed("Confused Vendor");
    const res = await importBook(vendor.id, [
      {
        styleNumber: "1",
        description: "",
        styleName: "",
        gradePrices: [{ grade: "D", cost: 900, material: "FABRIC" }],
      },
      {
        styleNumber: "2",
        description: "",
        styleName: "",
        gradePrices: [{ grade: "D", cost: 950, material: "LEATHER" }],
      },
    ]);
    expect(res.statusCode).toBe(400);
    expect(await prisma.vendorStyle.count()).toBe(0);
  });
});

describe("flat catalog with case packs (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("imports cost, retail and case pack, into existing categories, idempotently", async () => {
    const dept = await prisma.department.create({ data: { name: "Accessories & Decor" } });
    const wallDecor = await prisma.category.create({
      data: { name: "Wall Decor", departmentId: dept.id },
    });
    const rows = [
      {
        SKU: "TMD-M100",
        Name: "Round Mirror",
        Vendor: "Mirror Importer",
        Department: "Accessories & Decor",
        Category: "Wall Decor",
        Cost: "68.00",
        Retail: "149.00",
        "Case Pack": "2",
        Description: "Round mirror",
      },
    ];
    const entity = getImportEntity("product");
    if (!entity) throw new Error("no product entity");
    const mapping = suggestMapping(Object.keys(rows[0]), entity);
    expect(mapping.cartonQty).toBe("Case Pack");

    const first = await runGenericImport("product", mapping, rows, "test@holt");
    expect(first).toEqual({ imported: 1, skipped: 0, errors: [] });
    // A second run with the case pack left blank keeps the product's own.
    const again = await runGenericImport(
      "product",
      mapping,
      [{ ...rows[0], "Case Pack": "" }],
      "test@holt",
    );
    expect(again.errors).toEqual([]);

    const products = await prisma.product.findMany({ where: { productNumber: "TMD-M100" } });
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ categoryId: wallDecor.id, cartonQty: 2 });
    expect([Number(products[0].baseCost), Number(products[0].baseRetail)]).toEqual([68, 149]);
  });
});
