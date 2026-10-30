// /app/__tests__/integration/landedCost.integration.test.ts
//
// GAP-02: receiving corrections and landed cost.
//
//   - A PO's charges (freight, duty, crating) are spread across its lines, and a
//     receipt brings its units into the product's average landed cost at their
//     unit cost plus their share. Charges added or removed after goods arrived
//     land on what is on hand, and say how much could not.
//   - Landed cost values stock and is the cost of a new sale (the cart's side is
//     in cartPricingEndToEnd.integration.test.ts); catalog cost is untouched.
//   - A receipt can be taken back: its units leave stock from where they
//     landed and leave the average at the cost they came in at.
//   - A special order's PO lines name their order lines.
//
// Real routes, real permission gates, real database; next-auth's session is
// the only mock.

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
import { postMovement } from "@/lib/inventory/ledger";
import { landingPlaceId } from "@/lib/inventory/places";
import { toQty } from "@/lib/inventory/quantity";
import { onPaymentReceived } from "@/lib/paymentService";
import { getInventoryHealth } from "@/lib/reports/inventoryHealth";
import receiveRoute from "@/pages/api/purchasing/orders/[id]/receive";
import orderRoute from "@/pages/api/purchasing/orders/[id]";
import chargesRoute from "@/pages/api/purchasing/orders/[id]/charges/index";
import chargeRoute from "@/pages/api/purchasing/orders/[id]/charges/[chargeId]";
import unreceiveRoute from "@/pages/api/purchasing/receiving/[id]/unreceive";
import addLineRoute from "@/pages/api/sales/orders/[id]/line-items";
import { stockAt } from "../helpers/stock";

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(
  route: Route,
  userId: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: object; body?: object } = {},
) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
  });
  let status = 200;
  let payload: unknown;
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
  await route({ method, query, body, cookies: {} } as unknown as NextApiRequest, res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, body: JSON.parse(JSON.stringify(payload ?? null)) as any };
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
  vendorId: number;
  store: { id: number; name: string };
  sofa: number;
  chair: number;
  lamp: number;
  customerId: number;
};

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Co", slug: "test-co" },
  });
  await prisma.appSettings.create({ data: { organizationId: DEFAULT_ORG_ID, timezone: "UTC" } });
  invalidateAppSettingsCache();

  await makeStaff("ada", "ADMIN");
  await makeStaff("mia", "MANAGER"); // writes, receives, sees cost, adjusts inventory
  await makeStaff("bea", "BUYER"); // writes, receives, sees cost; does not adjust inventory
  await makeStaff("wes", "WAREHOUSE"); // receives only
  await prisma.role.create({
    data: {
      key: "ORDER_CLERK",
      name: "Order clerk",
      isSystem: false,
      permissions: {
        create: ["purchasing.read", "purchasing.write"].map((permission) => ({ permission })),
      },
    },
  });
  await makeStaff("oli", "ORDER_CLERK", "DATA_ENTRY"); // writes POs without seeing cost

  const vendor = await prisma.vendor.create({ data: { name: "Fernbrook" } });
  const dept = await prisma.department.create({ data: { name: "Living" } });
  const cat = await prisma.category.create({
    data: { name: "Seating", departmentId: dept.id, trackInventory: true },
  });
  const product = (n: string, baseCost: number, dims: object) =>
    prisma.product.create({
      data: {
        productNumber: n,
        name: n,
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
        baseCost,
        baseRetail: baseCost * 2,
        ...dims,
      },
    });
  w.vendorId = vendor.id;
  // 84 x 36 x 30 inches = 52.5 cubic feet; the chair carries its own cubic feet.
  w.sofa = (await product("Sofa", 800, { width: 84, depth: 36, height: 30 })).id;
  w.chair = (await product("Chair", 400, { cubicFeet: 15 })).id;
  w.lamp = (await product("Lamp", 50, {})).id;
  w.store = await prisma.storeLocation.create({
    data: { name: "Main", code: "MAIN", type: "STORE" },
  });
  w.customerId = (
    await prisma.customer.create({ data: { firstName: "Cara", lastName: "Hale" } })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function po(lines: [number, number, number][], status = "CONFIRMED") {
  return prisma.purchaseOrder.create({
    data: {
      poNumber: `PO-T-${Math.random().toString(36).slice(2, 8)}`,
      vendorId: w.vendorId,
      status: status as never,
      lineItems: {
        create: lines.map(([productId, orderedQuantity, unitCost]) => ({
          productId,
          orderedQuantity,
          unitCost,
        })),
      },
    },
    include: { lineItems: { orderBy: { id: "asc" } } },
  });
}

type Po = Awaited<ReturnType<typeof po>>;

async function receive(p: Po, quantities: number[], who = "mia") {
  const r = await call(receiveRoute, who, {
    method: "POST",
    query: { id: String(p.id) },
    body: {
      storeLocationId: w.store.id,
      items: p.lineItems
        .map((l, i) => ({ purchaseOrderItemId: l.id, quantityReceived: quantities[i] ?? 0 }))
        .filter((i) => i.quantityReceived > 0),
    },
  });
  expect(r.status).toBe(200);
  return r.body;
}

const charge = (poId: number, body: object, who = "bea") =>
  call(chargesRoute, who, { method: "POST", query: { id: String(poId) }, body });

const landed = async (productId: number) => {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  return {
    landedCost: p.landedCost === null ? null : Number(p.landedCost),
    baseCost: Number(p.baseCost),
  };
};

const onHand = async (productId: number, salesOrderId: number | null = null) =>
  toQty(
    (
      await prisma.inventoryPosition.aggregate({
        where: { productId, ...(salesOrderId === null ? {} : { salesOrderId }) },
        _sum: { quantity: true },
      })
    )._sum.quantity,
  );

const receipts = (purchaseOrderId: number) =>
  prisma.receivingRecord.findMany({ where: { purchaseOrderId }, orderBy: { id: "asc" } });

describe("landed charges and the average landed cost", () => {
  it("brings a receipt in at its unit cost plus its share of the charges, leaving catalog cost alone", async () => {
    const p = await po([
      [w.sofa, 2, 800],
      [w.chair, 4, 400],
    ]);
    // 2 x 800 and 4 x 400 are 1,600 each: by value, 300 each, so 150 a sofa and 75 a chair.
    const added = await charge(p.id, { description: "Freight", amount: 600, splitBy: "VALUE" });
    expect(added).toMatchObject({ status: 201, body: { unabsorbed: 0 } });
    await receive(p, [2, 4]);

    expect(await landed(w.sofa)).toEqual({ landedCost: 950, baseCost: 800 });
    expect(await landed(w.chair)).toEqual({ landedCost: 475, baseCost: 400 });
    expect((await receipts(p.id)).map((r) => Number(r.landedUnitCost))).toEqual([950, 475]);

    const detail = await call(orderRoute, "bea", { query: { id: String(p.id) } });
    expect(detail.body.charges).toEqual([
      expect.objectContaining({ description: "Freight", amount: 600, splitBy: "VALUE" }),
    ]);
    expect(detail.body.lineItems.map((l: { landedUnitCost: number }) => l.landedUnitCost)).toEqual([
      950, 475,
    ]);
  });

  it("averages what arrives with what was on hand, which stood at catalog cost", async () => {
    await stockAt({ productId: w.chair, storeLocationId: w.store.id, quantity: 2 });
    const p = await po([[w.chair, 4, 400]]);
    await charge(p.id, { description: "Freight", amount: 300, splitBy: "QUANTITY" });
    await receive(p, [4]);
    // 2 at 400 and 4 at 475.
    expect((await landed(w.chair)).landedCost).toBe(450);
  });

  it("lands a charge added after goods arrived on what is on hand, and says what found nothing to land on", async () => {
    const p = await po([[w.sofa, 2, 800]]);
    await receive(p, [2]);
    expect((await landed(w.sofa)).landedCost).toBe(800);

    const late = await charge(p.id, { description: "Freight", amount: 100, splitBy: "QUANTITY" });
    expect(late.body.unabsorbed).toBe(0);
    expect((await landed(w.sofa)).landedCost).toBe(850);
    expect(Number((await receipts(p.id))[0].landedUnitCost)).toBe(850);

    // Both sofas gone: a further charge has no stock to land on.
    const place = await landingPlaceId(prisma, w.store.id, "RECEIVING");
    await postMovement(prisma, {
      productId: w.sofa,
      quantity: 2,
      from: { storeLocationId: w.store.id, stockLocationId: place, salesOrderId: null },
      reason: "WRITE_OFF",
    });
    const tooLate = await charge(p.id, { description: "Duty", amount: 40, splitBy: "QUANTITY" });
    expect(tooLate.body.unabsorbed).toBe(40);
    expect((await landed(w.sofa)).landedCost).toBe(850);
    expect(Number((await receipts(p.id))[0].landedUnitCost)).toBe(870);
  });

  it("takes a removed charge's share back off", async () => {
    const p = await po([[w.sofa, 2, 800]]);
    const added = await charge(p.id, { description: "Freight", amount: 100, splitBy: "QUANTITY" });
    await receive(p, [2]);
    expect((await landed(w.sofa)).landedCost).toBe(850);

    const removed = await call(chargeRoute, "bea", {
      method: "DELETE",
      query: { id: String(p.id), chargeId: String(added.body.id) },
    });
    expect(removed).toMatchObject({ status: 200, body: { unabsorbed: 0 } });
    expect((await landed(w.sofa)).landedCost).toBe(800);
    expect(Number((await receipts(p.id))[0].landedUnitCost)).toBe(800);
    expect(await prisma.purchaseOrderCharge.count()).toBe(0);
  });

  it("splits by cubic volume from cubic feet or dimensions, and refuses a line with neither", async () => {
    const p = await po([
      [w.sofa, 2, 800],
      [w.chair, 4, 400],
    ]);
    // 2 x 52.5 = 105 and 4 x 15 = 60 cubic feet: 330 splits 210 and 120.
    await charge(p.id, { description: "Freight", amount: 330, splitBy: "VOLUME" });
    await receive(p, [2, 4]);
    expect((await landed(w.sofa)).landedCost).toBe(905);
    expect((await landed(w.chair)).landedCost).toBe(430);

    const withLamp = await po([
      [w.sofa, 1, 800],
      [w.lamp, 1, 50],
    ]);
    expect(
      await charge(withLamp.id, { description: "Freight", amount: 50, splitBy: "VOLUME" }),
    ).toMatchObject({
      status: 400,
      body: {
        error: "Lamp has no dimensions: add them on the product, or split this charge another way.",
      },
    });
  });

  it("splits a charge the store's way unless the buyer picks another", async () => {
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { landedCostSplit: "QUANTITY" },
    });
    invalidateAppSettingsCache();
    const p = await po([[w.sofa, 2, 800]]);
    await charge(p.id, { description: "Freight", amount: 10 });
    expect((await prisma.purchaseOrderCharge.findFirstOrThrow()).splitBy).toBe("QUANTITY");
    const detail = await call(orderRoute, "bea", { query: { id: String(p.id) } });
    expect(detail.body.defaultSplit).toBe("QUANTITY");
  });

  it("is for writers who see cost, on a PO that can still take charges", async () => {
    const p = await po([[w.sofa, 2, 800]]);
    expect((await charge(p.id, { description: "Freight", amount: 10 }, "oli")).status).toBe(403);
    expect((await charge(p.id, { description: "Freight", amount: 10 }, "wes")).status).toBe(403);
    // The PO screen shows a writer without View cost no charges and no landed cost.
    const blind = await call(orderRoute, "oli", { query: { id: String(p.id) } });
    expect(blind.body.charges).toBeUndefined();
    expect(blind.body.lineItems[0].landedUnitCost).toBeUndefined();

    await prisma.purchaseOrder.update({ where: { id: p.id }, data: { status: "CANCELLED" } });
    expect(await charge(p.id, { description: "Freight", amount: 10 })).toMatchObject({
      status: 409,
      body: { error: "A cancelled purchase order takes no landed charges." },
    });
  });
});

describe("landed cost values stock and costs a new sale", () => {
  it("values stock on hand at landed cost in the inventory health report", async () => {
    const p = await po([[w.sofa, 2, 800]]);
    await charge(p.id, { description: "Freight", amount: 100, splitBy: "QUANTITY" });
    await receive(p, [2]);
    const health = await getInventoryHealth(prisma, { pivot: "vendor" });
    const fern = health.rows.find((r) => r.key === "Fernbrook");
    expect(fern?.costValue).toBe(1700); // 2 x 850, not 2 x 800
  });

  it("costs a line added to an order at the product's landed cost", async () => {
    const p = await po([[w.sofa, 1, 800]]);
    await charge(p.id, { description: "Freight", amount: 90, splitBy: "QUANTITY" });
    await receive(p, [1]);
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-COST-1",
        status: "ORDER",
        orderDate: new Date(),
        customerId: w.customerId,
      },
    });
    const added = await call(addLineRoute, "mia", {
      method: "POST",
      query: { id: String(order.id) },
      body: { productId: w.sofa, productName: "Sofa", quantity: 2, unitPrice: 1600 },
    });
    expect(added.status).toBe(201);
    const line = await prisma.orderLineItem.findFirstOrThrow({ where: { salesOrderId: order.id } });
    expect(Number(line.cost)).toBe(1780); // 2 x 890
  });
});

describe("taking a receipt back", () => {
  async function chairsReceived() {
    await stockAt({ productId: w.chair, storeLocationId: w.store.id, quantity: 2 });
    const p = await po([[w.chair, 4, 400]]);
    await charge(p.id, { description: "Freight", amount: 300, splitBy: "QUANTITY" });
    await receive(p, [4]);
    const [record] = await receipts(p.id);
    return { p, record };
  }
  const takeBack = (recordId: number, quantity: unknown, who = "mia") =>
    call(unreceiveRoute, who, {
      method: "POST",
      query: { id: String(recordId) },
      body: { quantity },
    });

  it("takes units back off stock and out of the average, and the PO reads as received again", async () => {
    const { p, record } = await chairsReceived();
    expect((await landed(w.chair)).landedCost).toBe(450);

    const one = await takeBack(record.id, 1);
    expect(one).toMatchObject({
      status: 200,
      body: { remaining: 3, newStatus: "RECEIVED_PARTIAL" },
    });
    expect(await onHand(w.chair)).toBe(5);
    // 6 at 450 less 1 at 475.
    expect((await landed(w.chair)).landedCost).toBe(445);
    expect(Number((await receipts(p.id))[0].quantityReceived)).toBe(3);
    const moved = await prisma.stockMovement.findFirstOrThrow({ where: { reason: "UNRECEIVE" } });
    expect(moved).toMatchObject({
      actor: "mia@example.com",
      sourceType: "PurchaseOrder",
      sourceId: p.id,
    });

    const rest = await takeBack(record.id, 3);
    expect(rest).toMatchObject({ status: 200, body: { remaining: 0, newStatus: "CONFIRMED" } });
    expect(await receipts(p.id)).toEqual([]);
    expect(await onHand(w.chair)).toBe(2);
    expect((await landed(w.chair)).landedCost).toBe(400);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      "CONFIRMED",
    );
  });

  it("refuses when the units have moved on from where they landed, saying how many are still there", async () => {
    const { record } = await chairsReceived();
    const from = await landingPlaceId(prisma, w.store.id, "RECEIVING");
    const floor = await prisma.stockLocation.create({
      data: { storeLocationId: w.store.id, code: "FLOOR", name: "Floor", locationType: "FLOOR" },
    });
    await postMovement(prisma, {
      productId: w.chair,
      quantity: 5,
      from: { storeLocationId: w.store.id, stockLocationId: from, salesOrderId: null },
      to: { storeLocationId: w.store.id, stockLocationId: floor.id, salesOrderId: null },
      reason: "TRANSFER",
    });
    const r = await takeBack(record.id, 2);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/^Only 1 of these are still at .*where they were received/);
    expect(await onHand(w.chair)).toBe(6);
  });

  it("takes free units before committed ones, so an order keeps its goods as long as it can", async () => {
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-SPECIAL-1",
        status: "ORDER",
        orderDate: new Date(),
        customerId: w.customerId,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: w.sofa,
              productName: "Sofa",
              orderedQuantity: 2,
              netPrice: 3200,
              cost: 1600,
              vatRate: 0,
              vatAmount: 0,
              source: "ORDER" as const,
            },
          ],
        },
      },
    });
    await onPaymentReceived(order.id);
    const special = await prisma.purchaseOrder.findFirstOrThrow({
      where: { salesOrderId: order.id },
      include: { lineItems: true },
    });
    await receive(special as unknown as Po, [2]);
    expect(await onHand(w.sofa, order.id)).toBe(2);
    // A free sofa beside them at the receiving place.
    await stockAt({ productId: w.sofa, storeLocationId: w.store.id, quantity: 1 });

    const [record] = await receipts(special.id);
    expect((await takeBack(record.id, 1)).status).toBe(200);
    expect(await onHand(w.sofa, order.id)).toBe(2);
    expect(await onHand(w.sofa)).toBe(2);

    // No free stock left there: the order's own unit goes, and it needs one again.
    expect((await takeBack(record.id, 1)).status).toBe(200);
    expect(await onHand(w.sofa, order.id)).toBe(1);
    expect(await onHand(w.sofa)).toBe(1);
  });

  it("refuses an imported receipt, more than was received, and anyone without Adjust inventory", async () => {
    const { record } = await chairsReceived();
    expect(await takeBack(record.id, 5)).toMatchObject({
      status: 400,
      body: { error: "Take back more than 0 and no more than the 4 received." },
    });
    expect((await takeBack(record.id, 1, "bea")).status).toBe(403);
    expect((await takeBack(record.id, 1, "wes")).status).toBe(403);

    await prisma.receivingRecord.update({
      where: { id: record.id },
      data: { externalGipNo: "GIP-1", externalPorNo: "POR-1" },
    });
    expect(await takeBack(record.id, 1)).toMatchObject({
      status: 409,
      body: { error: "This receipt came in through the import; correct its stock with a count." },
    });
    expect(await onHand(w.chair)).toBe(6);
  });
});

describe("a special order's PO lines", () => {
  it("name the order line they were raised for, so a cancelled line's goods arrive free", async () => {
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-LINK-1",
        status: "ORDER",
        orderDate: new Date(),
        customerId: w.customerId,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: w.sofa,
              productName: "Sofa",
              orderedQuantity: 1,
              netPrice: 1600,
              cost: 800,
              vatRate: 0,
              vatAmount: 0,
              source: "ORDER" as const,
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    await onPaymentReceived(order.id);
    const special = await prisma.purchaseOrder.findFirstOrThrow({
      where: { salesOrderId: order.id },
      include: { lineItems: true },
    });
    expect(special.lineItems[0].orderLineItemId).toBe(order.lineItems[0].id);

    await prisma.orderLineItem.update({
      where: { id: order.lineItems[0].id },
      data: { lineItemStatus: "CANCELLED" },
    });
    await receive(special as unknown as Po, [1]);
    expect(await onHand(w.sofa, order.id)).toBe(0);
    expect(await onHand(w.sofa)).toBe(1);
  });
});
