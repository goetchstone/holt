// /app/__tests__/integration/scanOrder.integration.test.ts
//
// GAP-19: a reorder scanned on the handheld (pages/api/scan/order.ts,
// lib/purchasing/scannedOrder.ts). Each vendor's lines go on its newest open
// draft for the store, adding to a line already ordering the item, or on a new
// draft; an item bought from several vendors is ordered from the one chosen,
// at that vendor's number and cost; a resend adds nothing twice.
//
// Real route, real permission gate, real database. next-auth's session is the
// only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import orderRoute from "@/pages/api/scan/order";

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function call(
  userId: string,
  { method = "GET", query = {}, body = {} }: { method?: string; query?: object; body?: object },
): Promise<Reply> {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
  });
  let status = 200;
  let payload: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(p: unknown) {
      payload = p;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  await orderRoute({ method, query, body, cookies: {} } as unknown as NextApiRequest, res);
  return { status, body: JSON.parse(JSON.stringify(payload)) };
}

async function makeStaff(userId: string, roleKey: string, enumRole = roleKey) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: enumRole as never,
      roleId: role.id,
      isActive: true,
    },
  });
}

const w = {} as {
  fern: { id: number };
  quarry: { id: number };
  sofa: { id: number };
  chair: { id: number };
  lamp: { id: number };
  stool: { id: number };
  retired: { id: number };
  harbor: { id: number };
  mill: { id: number };
  shut: { id: number };
};

const PO_NUMBER = /^PO-\d{6}-\d{3}$/;
let keys = 0;
const key = () => `scan-order-${keys++}`;

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Co", slug: "test-co" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, companyName: "Linden Row Home", timezone: "UTC" },
  });
  invalidateAppSettingsCache();

  // An admin on file, so the bootstrap safeguard is off and each refusal is real.
  await makeStaff("ada", "ADMIN");
  await makeStaff("bea", "BUYER");
  await makeStaff("wes", "WAREHOUSE");
  // Writes POs and reads nothing of inventory: the page reads its own scans.
  await prisma.role.create({
    data: {
      key: "ORDER_CLERK",
      name: "Order clerk",
      isSystem: false,
      permissions: { create: [{ permission: "purchasing.write" }] },
    },
  });
  await makeStaff("oli", "ORDER_CLERK", "DATA_ENTRY");

  const dept = await prisma.department.create({ data: { name: "Living" } });
  const cat = await prisma.category.create({ data: { name: "Seating", departmentId: dept.id } });
  w.fern = await prisma.vendor.create({ data: { name: "Fernbrook Upholstery", leadTimeDays: 30 } });
  w.quarry = await prisma.vendor.create({ data: { name: "Quarry Hill" } });
  const product = (
    vendorId: number,
    productNumber: string,
    name: string,
    cost: number,
    extra = {},
  ) =>
    prisma.product.create({
      data: {
        productNumber,
        name,
        vendorId,
        baseCost: cost,
        departmentId: dept.id,
        categoryId: cat.id,
        ...extra,
      },
    });
  w.sofa = await product(w.fern.id, "FB-SOFA", "Ashby Sofa", 812);
  w.chair = await product(w.fern.id, "FB-CHAIR", "Ashby Chair", 400);
  w.lamp = await product(w.quarry.id, "QH-LAMP", "Quarry Lamp", 60);
  w.stool = await product(w.fern.id, "FB-STOOL", "Ashby Stool", 90, { isDiscontinued: true });
  w.retired = await product(w.fern.id, "FB-OLD", "Ashby Bench", 120, { isActive: false });
  await prisma.upc.create({ data: { upc: "0123456789012", productId: w.sofa.id } });
  // The sofa is also bought from Quarry Hill, under its number and at its cost.
  await prisma.productSource.create({
    data: { productId: w.sofa.id, vendorId: w.quarry.id, itemNumber: "QH-778", cost: "790.50" },
  });
  w.harbor = await prisma.storeLocation.create({
    data: { name: "Harbor", code: "HARB", type: "STORE" },
  });
  w.mill = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "WAREHOUSE" },
  });
  w.shut = await prisma.storeLocation.create({
    data: { name: "Old Annex", code: "OA", type: "STORE", isActive: false },
  });
  await prisma.stockLocation.create({
    data: { storeLocationId: w.harbor.id, code: "BAY-1", name: "Bay 1" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const scan = (code: string, userId = "bea") =>
  call(userId, { query: { code, storeLocationId: String(w.harbor.id) } });

const save = (lines: object[], over: object = {}, userId = "bea") =>
  call(userId, {
    method: "POST",
    body: { actionKey: key(), shipToLocationId: w.harbor.id, lines, ...over },
  });

const drafts = (vendorId: number) =>
  prisma.purchaseOrder.findMany({
    where: { vendorId },
    orderBy: { id: "asc" },
    include: { lineItems: { orderBy: { id: "asc" } } },
  });

const lineView = (l: {
  productId: number | null;
  partNo: string | null;
  orderedQuantity: unknown;
  unitCost: unknown;
}) => [l.productId, l.partNo, Number(l.orderedQuantity), Number(l.unitCost)];

beforeEach(async () => {
  await prisma.receivingRecord.deleteMany();
  await prisma.purchaseOrderItem.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.stockAction.deleteMany();
});

describe("scanning an item to reorder", () => {
  it("names the item and the vendors it is bought from, its own first, at each one's number", async () => {
    const r = await scan("0123456789012");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      product: { id: w.sofa.id, name: "Ashby Sofa", productNumber: "FB-SOFA" },
      vendors: [
        { id: w.fern.id, name: "Fernbrook Upholstery", partNo: "FB-SOFA" },
        { id: w.quarry.id, name: "Quarry Hill", partNo: "QH-778" },
      ],
    });
    expect((await scan("fb-chair")).body.vendors).toEqual([
      { id: w.fern.id, name: "Fernbrook Upholstery", partNo: "FB-CHAIR" },
    ]);
  });

  it("refuses what isn't reordered, a place, and a code that is nothing", async () => {
    expect(await scan("FB-STOOL")).toEqual({
      status: 400,
      body: { error: "Ashby Stool is discontinued, so it isn't reordered." },
    });
    expect(await scan("FB-OLD")).toEqual({
      status: 400,
      body: { error: "Ashby Bench is inactive, so it isn't reordered." },
    });
    const place = await scan("BAY-1");
    expect(place.status).toBe(400);
    expect(place.body.error).toMatch(/is a place: scan an item\.$/);
    expect((await scan("NOPE-404")).status).toBe(404);
  });

  it("is on Write purchase orders: a writer who reads no inventory scans, the warehouse can't", async () => {
    expect((await scan("FB-CHAIR", "oli")).status).toBe(200);
    expect((await scan("FB-CHAIR", "wes")).status).toBe(403);
    const refused = await save(
      [{ productId: w.chair.id, vendorId: w.fern.id, quantity: 1 }],
      {},
      "wes",
    );
    expect(refused.status).toBe(403);
    expect(await prisma.purchaseOrder.count()).toBe(0);
  });
});

describe("saving a scanned reorder", () => {
  it("makes a draft per vendor for the store, each item at the chosen vendor's number and cost", async () => {
    const r = await save([
      { productId: w.chair.id, vendorId: w.fern.id, quantity: 2 },
      { productId: w.sofa.id, vendorId: w.quarry.id, quantity: 1 },
      { productId: w.lamp.id, vendorId: w.quarry.id, quantity: "2.5" },
      { productId: w.chair.id, vendorId: w.fern.id, quantity: 1 },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.replayed).toBe(false);
    expect(
      r.body.pos.map((p: { vendor: string; lines: number; created: boolean }) => [
        p.vendor,
        p.lines,
        p.created,
      ]),
    ).toEqual([
      ["Fernbrook Upholstery", 1, true],
      ["Quarry Hill", 2, true],
    ]);
    for (const p of r.body.pos) expect(p.poNumber).toMatch(PO_NUMBER);

    const [fern] = await drafts(w.fern.id);
    expect(fern).toMatchObject({
      status: "DRAFT",
      shipToLocationId: w.harbor.id,
      createdBy: "bea@example.com",
      isReturn: false,
      salesOrderId: null,
    });
    // Lead time from the vendor: 30 days after the order date.
    expect(fern.expectedDelivery!.getTime() - fern.orderDate.getTime()).toBe(30 * 86_400_000);
    expect(fern.lineItems.map(lineView)).toEqual([[w.chair.id, "FB-CHAIR", 3, 400]]);

    const [quarry] = await drafts(w.quarry.id);
    expect(quarry.expectedDelivery).toBeNull();
    expect(quarry.lineItems.map(lineView)).toEqual([
      [w.sofa.id, "QH-778", 1, 790.5],
      [w.lamp.id, "QH-LAMP", 2.5, 60],
    ]);
  });

  it("adds to the vendor's newest open draft for the store: an item on it adds up and keeps its cost", async () => {
    const first = await save([{ productId: w.chair.id, vendorId: w.fern.id, quantity: 2 }]);
    const older = first.body.pos[0].id;
    const second = await save([{ productId: w.sofa.id, vendorId: w.fern.id, quantity: 1 }]);
    expect(second.body.pos[0]).toMatchObject({ id: older, created: false, lines: 1 });
    // The buyer changed the sofa's cost at the desk since.
    await prisma.purchaseOrderItem.updateMany({
      where: { purchaseOrderId: older, productId: w.sofa.id },
      data: { unitCost: 777 },
    });

    const r = await save(
      [
        { productId: w.sofa.id, vendorId: w.fern.id, quantity: 2 },
        { productId: w.chair.id, vendorId: w.fern.id, quantity: 1 },
      ],
      {},
      "oli",
    );
    expect(r.status).toBe(201);
    expect(r.body.pos).toEqual([
      expect.objectContaining({
        id: older,
        vendor: "Fernbrook Upholstery",
        lines: 2,
        created: false,
      }),
    ]);
    const [po] = await drafts(w.fern.id);
    expect(po.lineItems.map(lineView)).toEqual([
      [w.chair.id, "FB-CHAIR", 3, 400],
      [w.sofa.id, "FB-SOFA", 3, 777],
    ]);
    expect(po.updatedBy).toBe("oli@example.com");
  });

  it("adds a new line beside a cancelled one or one raised for a customer's order", async () => {
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-SCAN-1",
        status: "ORDER",
        orderDate: new Date(),
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: w.sofa.id,
              productName: "Ashby Sofa",
              orderedQuantity: 1,
              netPrice: 1800,
              cost: 812,
              vatRate: 0,
              vatAmount: 0,
              source: "ORDER" as const,
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    const draft = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PO-MIXED-1",
        vendorId: w.fern.id,
        shipToLocationId: w.harbor.id,
        status: "DRAFT",
        lineItems: {
          create: [
            { productId: w.chair.id, partNo: "FB-CHAIR", orderedQuantity: 0, unitCost: 400 },
            {
              productId: w.sofa.id,
              partNo: "FB-SOFA",
              orderedQuantity: 1,
              unitCost: 812,
              orderLineItemId: order.lineItems[0].id,
            },
          ],
        },
      },
    });
    const r = await save([
      { productId: w.chair.id, vendorId: w.fern.id, quantity: 2 },
      { productId: w.sofa.id, vendorId: w.fern.id, quantity: 1 },
    ]);
    expect(r.body.pos[0]).toMatchObject({ id: draft.id, created: false, lines: 2 });
    const [po] = await drafts(w.fern.id);
    expect(po.lineItems.map((l) => [...lineView(l), l.orderLineItemId])).toEqual([
      [w.chair.id, "FB-CHAIR", 0, 400, null],
      [w.sofa.id, "FB-SOFA", 1, 812, order.lineItems[0].id],
      [w.chair.id, "FB-CHAIR", 2, 400, null],
      [w.sofa.id, "FB-SOFA", 1, 812, null],
    ]);
  });

  it("takes the newest of two open drafts, and leaves the older alone", async () => {
    const make = (n: string) =>
      prisma.purchaseOrder.create({
        data: { poNumber: n, vendorId: w.fern.id, shipToLocationId: w.harbor.id, status: "DRAFT" },
      });
    const older = await make("PO-OLD-1");
    const newer = await make("PO-NEW-1");
    const r = await save([{ productId: w.chair.id, vendorId: w.fern.id, quantity: 1 }]);
    expect(r.body.pos[0]).toMatchObject({ id: newer.id, poNumber: "PO-NEW-1", created: false });
    expect(await prisma.purchaseOrderItem.count({ where: { purchaseOrderId: older.id } })).toBe(0);
  });

  it("starts a new draft rather than add to one sent, received against, for another store, or a return", async () => {
    const po = (data: object) =>
      prisma.purchaseOrder.create({
        data: {
          poNumber: `PO-X-${keys++}`,
          vendorId: w.fern.id,
          shipToLocationId: w.harbor.id,
          status: "DRAFT",
          ...data,
        },
      });
    await po({ status: "SUBMITTED" });
    await po({ shipToLocationId: w.mill.id });
    await po({ isReturn: true });
    const received = await po({});
    const line = await prisma.purchaseOrderItem.create({
      data: { purchaseOrderId: received.id, productId: w.chair.id, orderedQuantity: 1 },
    });
    await prisma.receivingRecord.create({
      data: {
        purchaseOrderId: received.id,
        purchaseOrderItemId: line.id,
        quantityReceived: 1,
        receiverUserId: "bea",
      },
    });
    const before = await prisma.purchaseOrderItem.count();

    const r = await save([{ productId: w.chair.id, vendorId: w.fern.id, quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(r.body.pos[0].created).toBe(true);
    expect(await prisma.purchaseOrderItem.count()).toBe(before + 1);
  });

  it("refuses an item the vendor doesn't sell us, a closed store, and a bad line, writing nothing", async () => {
    const wrong = await save([
      { productId: w.chair.id, vendorId: w.fern.id, quantity: 1 },
      { productId: w.chair.id, vendorId: w.quarry.id, quantity: 1 },
    ]);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain("Quarry Hill doesn't sell us Ashby Chair");
    const shut = await save([{ productId: w.chair.id, vendorId: w.fern.id, quantity: 1 }], {
      shipToLocationId: w.shut.id,
    });
    expect(shut.status).toBe(400);
    expect(shut.body.error).toBe("Choose an open store or warehouse for the vendor to deliver to.");
    const zero = await save([{ productId: w.chair.id, vendorId: w.fern.id, quantity: 0 }]);
    expect(zero.status).toBe(400);
    expect(await prisma.purchaseOrder.count()).toBe(0);
    expect(await prisma.stockAction.count()).toBe(0);
  });

  it("a resend with the same key adds nothing twice", async () => {
    const body = {
      actionKey: "scan-order-resend-1",
      shipToLocationId: w.harbor.id,
      lines: [{ productId: w.chair.id, vendorId: w.fern.id, quantity: 2 }],
    };
    const first = await call("bea", { method: "POST", body });
    expect(first.status).toBe(201);
    const again = await call("bea", { method: "POST", body });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ pos: first.body.pos, replayed: true });
    const [po] = await drafts(w.fern.id);
    expect(po.lineItems.map(lineView)).toEqual([[w.chair.id, "FB-CHAIR", 2, 400]]);
  });

  it("numbers drafts saved at the same moment without a clash", async () => {
    const results = await Promise.all([
      save([{ productId: w.chair.id, vendorId: w.fern.id, quantity: 1 }]),
      save([{ productId: w.lamp.id, vendorId: w.quarry.id, quantity: 1 }]),
      save([{ productId: w.chair.id, vendorId: w.fern.id, quantity: 1 }], {
        shipToLocationId: w.mill.id,
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const numbers = (await prisma.purchaseOrder.findMany()).map((p) => p.poNumber);
    expect(numbers).toHaveLength(3);
    expect(new Set(numbers).size).toBe(3);
  });
});
