// /app/__tests__/integration/wholesaleImportToRetail.integration.test.ts
//
// The "stranger imports, sets a markup, sells" proof (VAL-05), against a real
// database. It ties the two money-path halves together:
//   - VAL-00's wholesale import (a parsed price book becomes VendorStyles), and
//   - USE-04's fail-closed markup (retail = cost x markup, or nothing at all).
//
// A Sam Moore fabric book is parsed by the real grid engine, imported through
// the real write handler, priced through the real products handler + calculator.
// With a markup set, retail is cost x markup; with none, the products handler
// reports UNCONFIGURED_MARKUP and the calculator refuses to invent a price.
//
// Every price in the fixture is INVENTED (this repo is public). The layout is a
// real Sam Moore book's; the numbers are not.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { parseRenderedGrid } from "@/lib/pricing/wholesale/columnGrid";
import { wholesaleProfileFor } from "@/lib/pricing/wholesale/registry";
import { handler as wholesaleImport } from "@/pages/api/pricing/import/wholesale-prices";
import { handler as productsHandler } from "@/pages/api/pricing/products";
import { calculatePrice, type ProductWithPricing } from "@/lib/pricing/priceCalculator";

const sessionMock = getServerSession as jest.Mock;
const adminSession = { user: { email: "admin@store.com" } } as unknown as Session;

// A two-style letter-laddered Sam Moore fabric book. Invented prices.
const page = (n: number, body: string) => `<<PAGE:${n}>>\n${body}`;
const SAM_MOORE = page(
  4,
  [
    "STYLE NUMBER:\t1034\t1035",
    "STYLE NAME:\tNova\tOrion",
    "STYLE DESCRIPTION:\tSwivel Chair\tClub Chair",
    'COM\t54" PLAIN COM FABRIC Required (Yds.):\t6 1/2\t7',
    "OVERALL Width:\t31 1/2\t33",
    "Grade: B\t$500\t$540",
    "Grade: C\t$525\t$565",
    "Grade: E and COM\t$575\t$615",
    "Grade: J\t$700\t--",
    "Premium: Prem 1\t$800\t$840",
    "Premium: Prem 2\t$850\t$890",
  ].join("\n"),
);

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
      priceListName: "Sam Moore Wholesale",
      mode: "renew",
      sourceBook: "wholesale",
      products,
    },
  } as unknown as NextApiRequest;
  await wholesaleImport(req, res, adminSession);
  return res;
}

interface ProductsResponse {
  vendor: { defaultMarkup: number | null; pricingStatus?: string };
  products: ProductWithPricing[];
}

async function fetchProducts(vendorId: number) {
  sessionMock.mockResolvedValue(adminSession);
  const res = makeRes();
  const req = {
    method: "GET",
    query: { vendorId: String(vendorId) },
    cookies: {},
  } as unknown as NextApiRequest;
  await productsHandler(req, res);
  return res;
}

describe("wholesale import -> markup -> retail (real DB, E2E)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a stranger imports Sam Moore, sets a markup, and sells at cost x markup", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Sam Moore", code: "SM", pricingModel: "GRADE_BASED" },
    });

    // Parse the book with the real grid engine.
    const parsed = parseRenderedGrid(SAM_MOORE, wholesaleProfileFor("sam-moore")!).data;
    expect(parsed.map((p) => p.styleNumber)).toEqual(["1034", "1035"]);

    // Import it through the real write handler.
    const imported = await importBook(vendor.id, parsed);
    expect(imported.statusCode).toBe(200);

    // The store sets a 3x markup.
    await prisma.vendor.update({ where: { id: vendor.id }, data: { defaultMarkup: 3.0 } });

    const resp = await fetchProducts(vendor.id);
    expect(resp.statusCode).toBe(200);
    const body = resp.body as ProductsResponse;
    expect(body.vendor.defaultMarkup).toBe(3);
    expect(body.vendor.pricingStatus).toBe("OK");

    const nova = body.products.find((p) => p.productNumber === "1034");
    expect(nova).toBeDefined();
    // Grade B's dealer cost round-tripped through parse + import is $500.
    const gradeB = nova!.gradePrices.find((gp) => gp.cost === 500);
    expect(gradeB).toBeDefined();

    // Retail = cost x markup = 500 x 3 = 1500.
    const priced = calculatePrice(nova!, gradeB!.tierId, new Set(), body.vendor.defaultMarkup);
    expect(priced.suggestedRetail).toBe(1500);

    // The store clears the markup -> the catalog fails closed.
    await prisma.vendor.update({ where: { id: vendor.id }, data: { defaultMarkup: null } });
    const resp2 = await fetchProducts(vendor.id);
    const body2 = resp2.body as ProductsResponse;
    expect(body2.vendor.defaultMarkup).toBeNull();
    expect(body2.vendor.pricingStatus).toBe("UNCONFIGURED_MARKUP");

    const nova2 = body2.products.find((p) => p.productNumber === "1034")!;
    const gradeB2 = nova2.gradePrices.find((gp) => gp.cost === 500)!;
    const unpriced = calculatePrice(nova2, gradeB2.tierId, new Set(), body2.vendor.defaultMarkup);
    expect(unpriced.suggestedRetail).toBeNull();
  });
});
