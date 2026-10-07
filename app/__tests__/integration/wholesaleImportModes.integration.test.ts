// /app/__tests__/integration/wholesaleImportModes.integration.test.ts
//
// PR 0b, against a real database: a wholesale import must retire only its OWN
// book's styles, never a companion catalog under the same vendor, and a
// Delete & Renew that would retire most of the book must ask before it does.
//
// Before sourceBook + modes, the handler discontinued EVERY style of the vendor
// before its product loop -- so importing an upholstery book wiped the vendor's
// casegoods, and a wrong-edition book that parsed to three styles retired the
// rest. These cases pin that it no longer does.
//
// Invokes the exported handler directly (bypassing the requirePermission
// wrapper) with a stub session; schema from `prisma db push` in the integration
// setup. Prices are invented.

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

const session = { user: { email: "importer@store.com" } } as unknown as Session;

/** One valid wholesale product with a single grade price. Prices invented. */
function style(styleNumber: string, cost = 500) {
  return {
    styleNumber,
    description: `desc ${styleNumber}`,
    styleName: `name ${styleNumber}`,
    gradePrices: [{ grade: "B", cost }],
  };
}

async function importBook(opts: {
  vendorId: number;
  sourceBook: string;
  mode: "renew" | "update";
  styleNumbers: string[];
  confirmShrink?: boolean;
}) {
  const res = makeRes();
  const req = {
    method: "POST",
    query: {},
    cookies: {},
    body: {
      vendorId: opts.vendorId,
      priceListName: `${opts.sourceBook} book`,
      mode: opts.mode,
      sourceBook: opts.sourceBook,
      ...(opts.confirmShrink ? { confirmShrink: true } : {}),
      products: opts.styleNumbers.map((n) => style(n)),
    },
  } as unknown as NextApiRequest;
  await wholesaleImport(req, res, session);
  return res;
}

const activeStyles = (vendorId: number, sourceBook?: string) =>
  prisma.vendorStyle.findMany({
    where: { vendorId, isDiscontinued: false, ...(sourceBook ? { sourceBook } : {}) },
    select: { styleNumber: true, sourceBook: true },
  });

describe("wholesale import modes (real DB)", () => {
  let vendorId: number;

  beforeEach(async () => {
    await resetTestDb();
    const vendor = await prisma.vendor.create({
      data: { name: "Test Upholstery Co", code: "TUC", pricingModel: "FLAT" },
    });
    vendorId = vendor.id;
  });

  it("tags each imported style with its sourceBook", async () => {
    const res = await importBook({
      vendorId,
      sourceBook: "wholesale",
      mode: "renew",
      styleNumbers: ["A1", "A2", "A3", "A4"],
    });
    expect(res.statusCode).toBe(200);
    const styles = await activeStyles(vendorId);
    expect(styles).toHaveLength(4);
    expect(styles.every((s) => s.sourceBook === "wholesale")).toBe(true);
  });

  it("a renew of one book leaves a companion book under the same vendor untouched", async () => {
    await importBook({
      vendorId,
      sourceBook: "wholesale",
      mode: "renew",
      styleNumbers: ["A1", "A2", "A3", "A4"],
    });
    await importBook({
      vendorId,
      sourceBook: "casegoods",
      mode: "renew",
      styleNumbers: ["C1", "C2"],
    });

    // Re-import the wholesale book with a DIFFERENT set -> its own stale styles
    // retire, but casegoods must be wholly unaffected.
    const res = await importBook({
      vendorId,
      sourceBook: "wholesale",
      mode: "renew",
      styleNumbers: ["A1", "A2", "A3"],
    });
    expect(res.statusCode).toBe(200);

    const wholesale = await activeStyles(vendorId, "wholesale");
    expect(wholesale.map((s) => s.styleNumber).sort()).toEqual(["A1", "A2", "A3"]);
    const casegoods = await activeStyles(vendorId, "casegoods");
    expect(casegoods.map((s) => s.styleNumber).sort()).toEqual(["C1", "C2"]);
  });

  it("update mode retires nothing", async () => {
    await importBook({
      vendorId,
      sourceBook: "wholesale",
      mode: "renew",
      styleNumbers: ["A1", "A2", "A3", "A4"],
    });
    // Update with just one existing style -> the other three stay active.
    const res = await importBook({
      vendorId,
      sourceBook: "wholesale",
      mode: "update",
      styleNumbers: ["A1"],
    });
    expect(res.statusCode).toBe(200);
    const styles = await activeStyles(vendorId, "wholesale");
    expect(styles.map((s) => s.styleNumber).sort()).toEqual(["A1", "A2", "A3", "A4"]);
  });

  it("a renew that would retire most of the book returns 409 until confirmed", async () => {
    await importBook({
      vendorId,
      sourceBook: "wholesale",
      mode: "renew",
      styleNumbers: ["A1", "A2", "A3", "A4"],
    });

    const refused = await importBook({
      vendorId,
      sourceBook: "wholesale",
      mode: "renew",
      styleNumbers: ["A1"],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatchObject({ existing: 4, incoming: 1 });
    // Nothing changed: all four still active.
    expect(await activeStyles(vendorId, "wholesale")).toHaveLength(4);

    const confirmed = await importBook({
      vendorId,
      sourceBook: "wholesale",
      mode: "renew",
      styleNumbers: ["A1"],
      confirmShrink: true,
    });
    expect(confirmed.statusCode).toBe(200);
    expect((await activeStyles(vendorId, "wholesale")).map((s) => s.styleNumber)).toEqual(["A1"]);
  });
});
