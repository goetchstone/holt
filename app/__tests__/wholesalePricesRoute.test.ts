// /app/__tests__/wholesalePricesRoute.test.ts
//
// The price-book import route is a wrapper: lib/pricing/importWholesaleBook.ts
// does the import and returns an outcome, and the route turns each outcome
// into the status and body the import screen reads. This pins that mapping
// (the import itself is the real-DB wholesaleImport*.integration tests).

jest.mock("@/lib/pricing/importWholesaleBook", () => ({
  importWholesaleBook: jest.fn(),
  SHRINK_GUARD_RATIO: 0.5,
}));
jest.mock("@/lib/logger", () => ({ logError: jest.fn(), logger: { info: jest.fn() } }));
jest.mock("@/lib/auth/requireAuth", () => ({
  requirePermission: (_key: string, h: unknown) => h,
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { importWholesaleBook } from "@/lib/pricing/importWholesaleBook";
import { handler } from "@/pages/api/pricing/import/wholesale-prices";

const importMock = importWholesaleBook as jest.Mock;
const session = { user: { email: "buyer@store.com" } } as unknown as Session;

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

const book = {
  vendorId: 7,
  priceListName: "Wholesale",
  products: [
    {
      styleNumber: "100",
      description: "Sofa",
      styleName: "A",
      gradePrices: [{ grade: "14", cost: 900 }],
    },
  ],
};

async function post(body: unknown = book) {
  const res = makeRes();
  const req = { method: "POST", query: {}, cookies: {}, body } as unknown as NextApiRequest;
  await handler(req, res as unknown as NextApiResponse, session);
  return res;
}

beforeEach(() => importMock.mockReset());

describe("POST /api/pricing/import/wholesale-prices", () => {
  it("imports the validated book as the signed-in user and answers 200", async () => {
    importMock.mockResolvedValue({
      kind: "ok",
      importedCount: 1,
      skippedCount: 0,
      errors: [],
      priceListId: 3,
    });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      importedCount: 1,
      skippedCount: 0,
      errors: [],
      priceListId: 3,
    });
    expect(importMock).toHaveBeenCalledWith(
      expect.objectContaining({ vendorId: 7, mode: "renew", sourceBook: "wholesale" }),
      "buyer@store.com",
    );
  });

  it("answers 404 for an unknown vendor", async () => {
    importMock.mockResolvedValue({ kind: "vendor-not-found" });
    const res = await post();
    expect([res.statusCode, res.body]).toEqual([404, { error: "Vendor not found" }]);
  });

  it("answers 409 with the numbers when a renew would retire most of the book", async () => {
    importMock.mockResolvedValue({
      kind: "shrink-refused",
      vendorName: "Test Vendor",
      existing: 4,
      incoming: 1,
      sourceBook: "wholesale",
    });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error:
        "This book would retire 3 of 4 active wholesale styles for Test Vendor. If that is really " +
        "the new catalog, re-submit with confirmShrink: true; if not, this is the wrong book or a partial parse.",
      existing: 4,
      incoming: 1,
      sourceBook: "wholesale",
    });
  });

  it("answers 422 when no style imported, saying nothing changed", async () => {
    importMock.mockResolvedValue({
      kind: "nothing-imported",
      skippedCount: 2,
      errors: ["Style 1: x"],
    });
    const res = await post();
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({
      success: false,
      importedCount: 0,
      skippedCount: 2,
      errors: ["Style 1: x"],
      error: "No styles could be imported from this book; nothing was changed.",
    });
  });

  it("answers 500 without internals when the import throws", async () => {
    importMock.mockRejectedValue(new Error('relation "VendorStyle" does not exist'));
    const res = await post();
    expect([res.statusCode, res.body]).toEqual([500, { error: "Import failed" }]);
  });

  it("refuses a body that fails validation without importing", async () => {
    const res = await post({ vendorId: 7, priceListName: "W", products: [] });
    expect(res.statusCode).toBe(400);
    expect(importMock).not.toHaveBeenCalled();
  });
});
