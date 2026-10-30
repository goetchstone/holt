// /app/__tests__/integration/wholesaleImportOptions.integration.test.ts
//
// A price book's options reach the database. Until 2026-10-29 the import's
// body schema (lib/validation/schemas.ts) did not declare `styleOptions` or
// eighteen of the option fields the route reads, and z.object() strips what
// it does not declare: every parser produced them, the screen posted them,
// and the route never saw them. So no book's per-style options and none of
// those vendor-map surcharges (castors, CDC seat, Harmony, contrast welt,
// fiber/comfort/legacy down back, extra-full back) were ever written, and a
// configured special order was priced without them.
//
// Real handler, real validation, real database. Every price is INVENTED.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handler as wholesaleImport } from "@/pages/api/pricing/import/wholesale-prices";

const adminSession = { user: { email: "admin@store.com" } } as unknown as Session;

function makeRes() {
  let statusCode = 0;
  let body: unknown = undefined;
  const res = {
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    end(payload?: unknown) {
      body = payload;
      return res;
    },
    setHeader() {},
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
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
  await wholesaleImport(req, res, adminSession);
  return res;
}

const option = (over: Record<string, unknown>) => ({
  surchargeType: "FLAT",
  isStandard: false,
  isAvailable: true,
  requiresTextInput: false,
  textInputLabel: null,
  sortOrder: 0,
  ...over,
});

async function overridesOf(styleNumber: string) {
  const rows = await prisma.styleOptionOverride.findMany({
    where: { vendorStyle: { styleNumber } },
    include: { option: { include: { group: true } } },
    orderBy: { option: { name: "asc" } },
  });
  return rows.map((r) => ({
    group: r.option.group.name,
    option: r.option.name,
    surcharge: r.surcharge === null ? null : Number(r.surcharge),
    isStandard: r.isStandard,
    isAvailable: r.isAvailable,
  }));
}

describe("wholesale import keeps a book's options (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("writes each style's own book options, available or not", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Test Custom Upholstery", code: "TCU", pricingModel: "FLAT" },
    });
    const res = await importBook(vendor.id, [
      {
        styleNumber: "4100-S",
        description: "Sofa",
        styleName: "Harlan",
        gradePrices: [{ grade: "14", cost: 900 }],
        styleOptions: [
          option({ groupName: "Nailhead", optionName: "Natural Brass", surcharge: 85 }),
          option({
            groupName: "Skirt",
            optionName: "Kick Pleat",
            surcharge: 0,
            isAvailable: false,
          }),
          option({ groupName: "Finish", optionName: "Espresso", surcharge: 0, isStandard: true }),
        ],
      },
    ]);
    expect(res.statusCode).toBe(200);

    expect(await overridesOf("4100-S")).toEqual([
      { group: "Finish", option: "Espresso", surcharge: 0, isStandard: true, isAvailable: true },
      { group: "Skirt", option: "Kick Pleat", surcharge: 0, isStandard: false, isAvailable: false },
      {
        group: "Nailhead",
        option: "Natural Brass",
        surcharge: 85,
        isStandard: false,
        isAvailable: true,
      },
    ]);
  });

  it("writes a vendor-map surcharge the schema used to strip", async () => {
    // The vendor-level map in wholesale-prices.ts prices castors per style for
    // this vendor key; the field was produced by the parser and dropped here.
    const vendor = await prisma.vendor.create({
      data: { name: "Wesley Hall", code: "WH", pricingModel: "FLAT" },
    });
    const res = await importBook(vendor.id, [
      {
        styleNumber: "1220",
        description: "Chair",
        styleName: "Test Chair",
        gradePrices: [{ grade: "14", cost: 700 }],
        castorSurcharge: 60,
        castorIsStandard: false,
      },
    ]);
    expect(res.statusCode).toBe(200);

    expect(await overridesOf("1220")).toEqual(
      expect.arrayContaining([
        {
          group: "Special Features",
          option: "Castors",
          surcharge: 60,
          isStandard: false,
          isAvailable: true,
        },
      ]),
    );
  });
});
