// __tests__/integration/consignmentVendorRefusal.integration.test.ts
//
// A deployment with no vendor flagged isConsignment. Every consignment route
// that writes against the consigning vendor answers 404 with what to set, from
// one shared check that runs before the route starts work
// (lib/consignmentVendor.ts consignmentVendorOr404, rule 42), and writes
// nothing: no vendor made up, no department, no receipt, no rug.
//
// Four imports used to throw that message from inside their transaction, so it
// reached the caller only as a 500's body, and since 500 bodies carry no error
// text (rule 11) it read "Import failed". Real database, real routes; only the
// session readers are mocked.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { NO_CONSIGNMENT_VENDOR } from "@/lib/consignmentVendor";
import consignmentItemsRoute from "@/pages/api/consignment/import/consignment-items";
import manifestRoute from "@/pages/api/consignment/import/manifest";
import paymentLinesRoute from "@/pages/api/consignment/import/payment-lines";
import salesLinesRoute from "@/pages/api/consignment/import/sales-lines";
import backfillFromPosRoute from "@/pages/api/consignment/import/backfill-from-pos";
import vendorReturnsRoute from "@/pages/api/consignment/import/vendor-returns";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(route: Route, body: object, query: Record<string, string> = {}) {
  const session = { user: { id: "boss", email: "boss@example.com" } };
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  await route(
    { method: "POST", query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return { status, body: payload };
}

/** Every table a consignment route writes, counted. */
async function written() {
  const [vendors, departments, products, receipts, items, batches, returns, saleLines] =
    await Promise.all([
      prisma.vendor.count(),
      prisma.department.count(),
      prisma.product.count(),
      prisma.consignmentReceipt.count(),
      prisma.consignmentItem.count(),
      prisma.consignmentPaymentBatch.count(),
      prisma.consignmentVendorReturn.count(),
      prisma.consignmentSaleLine.count(),
    ]);
  return { vendors, departments, products, receipts, items, batches, returns, saleLines };
}

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({ data: { organizationId: DEFAULT_ORG_ID, appName: "Holt" } });
  invalidateAppSettingsCache();
  await prisma.user.create({ data: { id: "boss", email: "boss@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.staffMember.create({
    data: { userId: "boss", displayName: "boss", role: "ADMIN", roleId: role.id },
  });
  // A vendor that does not consign: the check is by flag, not "any vendor".
  await prisma.vendor.create({ data: { name: "Harbor Works", isConsignment: false } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ROUTES: [string, Route, object][] = [
  [
    "the consignment items import",
    consignmentItemsRoute,
    { rows: [{ barcode: "RUG-1", cost: "100" }] },
  ],
  ["the manifest import", manifestRoute, { items: [{ rugNumber: "RUG-1", cost: "100" }] }],
  [
    "the payment lines import",
    paymentLinesRoute,
    { rows: [{ kf_payment_id: "PAY-1", rug_id: "RUG-1", total_payment: "100" }] },
  ],
  [
    "the sale lines import",
    salesLinesRoute,
    { rows: [{ kf_sale_transaction_id: "SALE-1", kf_rug_barcode: "RUG-1" }] },
  ],
  ["the backfill from POS data", backfillFromPosRoute, {}],
  ["the vendor return import", vendorReturnsRoute, { barcodes: ["RUG-1"] }],
];

describe("with no consignment vendor configured", () => {
  it.each(ROUTES)(
    "%s answers 404 with what to set, and writes nothing",
    async (_name, route, body) => {
      const before = await written();
      const res = await call(route, body);
      expect(res).toEqual({ status: 404, body: { error: NO_CONSIGNMENT_VENDOR } });
      expect(await written()).toEqual(before);
    },
  );
});

describe("with a consignment vendor configured", () => {
  it("the backfill gets past the check and runs (a dry run, on no data)", async () => {
    await prisma.vendor.create({ data: { name: "Loom Consignor", isConsignment: true } });
    const res = await call(backfillFromPosRoute, {}, { dryRun: "true" });
    expect(res).toEqual({
      status: 200,
      body: {
        dryRun: true,
        soldSynced: 0,
        paidSynced: 0,
        batchesCreated: 0,
        creditsDetected: 0,
        details: [],
      },
    });
  });

  it("the vendor return import records the return against the flagged vendor", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Loom Consignor", isConsignment: true },
    });
    await prisma.consignmentItem.create({
      data: {
        vendorId: vendor.id,
        barcode: "RUG-1",
        cost: 100,
        anchorPrice: 250,
        retailPrice: 200,
        status: "ON_FLOOR",
      },
    });
    const res = await call(vendorReturnsRoute, { barcodes: ["RUG-1", "RUG-404"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ itemsReturned: 1, notFound: ["RUG-404"] });
    const returns = await prisma.consignmentVendorReturn.findMany();
    expect(returns.map((r) => r.vendorId)).toEqual([vendor.id]);
  });
});
