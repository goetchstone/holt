// /app/__tests__/integration/cartPricingEndToEnd.integration.test.ts
//
// The property that was violated in production: **what the customer is charged
// and what the database records must be the same number.**
//
// The unit tests in __tests__/cartPricing.test.ts prove the arithmetic. They
// cannot prove the WIRING, and the wiring is where the bug lived -- the POS
// and the endpoint each computed a total correctly by their own lights and
// disagreed. So this asserts against real persisted rows: the line items and
// tax actually written to the database must add up to the total the endpoint
// hands back for the register to charge.
//
// A $1,000 sale with $100 off at 6.35% previously charged $900 (the client's
// figure: discounts applied, no tax) while recording $1,063.50 (the server's:
// full price plus tax, no discount), leaving $163.50 outstanding forever.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handler } from "@/pages/api/sales/orders/create-from-cart";

function makeReq(body: unknown): NextApiRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { method: "POST", query: {}, body } as any;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as NextApiResponse & { statusCode: number; body: unknown };
  return res;
}

const session = { user: { email: "register@example.com" } } as unknown as Session;

const CT_RATE = 0.0635;

async function seedCatalogAndTax() {
  const vendor = await prisma.vendor.create({
    data: { name: "Test Vendor", pricingModel: "FLAT" },
  });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE" },
  });

  // shortName "CT" is not incidental -- it matches the real seed district
  // (prisma/seed/demo/accounting.ts). create-from-cart no longer resolves it
  // with a hardcoded `where: { shortName: "CT" }`; it goes through
  // resolveTaxRate.ts's resolution order (customer override, then the
  // store's own district, then AppSettings.defaultTaxDistrictId). The
  // `taxDistrictId` set on the store below IS that fix under test -- remove
  // it and every assertion in this file charging 6.35% would fail closed to
  // $0, which is exactly the bug src/lib/tax/resolveTaxRate.ts replaces.
  const district = await prisma.taxDistrict.create({
    data: { shortName: "CT", state: "CT", name: "Connecticut State Sales Tax", isActive: true },
  });
  const group = await prisma.taxGroup.create({ data: { name: "Standard Retail" } });
  await prisma.taxRule.create({
    data: { districtId: district.id, groupId: group.id, taxRate: CT_RATE, sortOrder: 0 },
  });
  await prisma.storeLocation.update({
    where: { id: store.id },
    data: { taxDistrictId: district.id },
  });

  const product = await prisma.product.create({
    data: {
      productNumber: "SOFA-1",
      name: "Test Sofa",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
      baseRetail: 1000,
    },
  });

  return { store, product, district };
}

/** Sum what actually landed in the database for an order. */
async function recordedTotal(orderId: number): Promise<number> {
  const lines = await prisma.orderLineItem.findMany({
    where: { salesOrderId: orderId },
    select: { netPrice: true, vatAmount: true },
  });
  const sum = lines.reduce((acc, l) => acc + Number(l.netPrice) + Number(l.vatAmount ?? 0), 0);
  return Math.round(sum * 100) / 100;
}

describe("cart pricing end to end (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("charges and records the same number for a discounted, taxed sale", async () => {
    const { store, product } = await seedCatalogAndTax();

    const res = makeRes();
    await handler(
      makeReq({
        storeLocation: store.name,
        items: [{ productId: product.id, quantity: 1, unitPrice: 1000 }],
        orderDiscount: { type: "AMOUNT", value: 100 },
      }),
      res,
      session,
    );

    expect(res.statusCode).toBe(201);
    const payload = res.body as { id: number; total: number; taxAmount: number };

    // 900 net, taxed at 6.35% -> 57.15. The old behaviour charged 900 flat.
    expect(payload.total).toBe(957.15);
    expect(payload.taxAmount).toBe(57.15);

    // The load-bearing assertion: the database agrees with the register.
    expect(await recordedTotal(payload.id)).toBe(payload.total);
  });

  it("applies item-level discounts, which the endpoint used to receive and ignore", async () => {
    const { store, product } = await seedCatalogAndTax();

    const res = makeRes();
    await handler(
      makeReq({
        storeLocation: store.name,
        items: [
          {
            productId: product.id,
            quantity: 1,
            unitPrice: 1000,
            discounts: [{ type: "PERCENT", value: 10 }],
          },
        ],
      }),
      res,
      session,
    );

    expect(res.statusCode).toBe(201);
    const payload = res.body as { id: number; total: number };

    // 900 after the item discount, plus 6.35% = 957.15. Previously the line
    // was written at the full 1000 and taxed on 1000.
    expect(payload.total).toBe(957.15);
    expect(await recordedTotal(payload.id)).toBe(payload.total);

    const [line] = await prisma.orderLineItem.findMany({
      where: { salesOrderId: payload.id },
      select: { netPrice: true, vatAmount: true },
    });
    expect(Number(line.netPrice)).toBe(900);
    expect(Number(line.vatAmount)).toBe(57.15);
  });

  it("taxes the discounted amount, not the list price", async () => {
    const { store, product } = await seedCatalogAndTax();

    const res = makeRes();
    await handler(
      makeReq({
        storeLocation: store.name,
        items: [{ productId: product.id, quantity: 2, unitPrice: 1000 }],
        orderDiscount: { type: "PERCENT", value: 50 },
      }),
      res,
      session,
    );

    const payload = res.body as { id: number; total: number; taxAmount: number };
    // 2000 -> 1000 after 50% off. Tax on 1000, not on 2000.
    expect(payload.taxAmount).toBe(63.5);
    expect(payload.total).toBe(1063.5);
    expect(await recordedTotal(payload.id)).toBe(payload.total);
  });

  it("persists totalTax on the order so the books see the same figure", async () => {
    const { store, product } = await seedCatalogAndTax();

    const res = makeRes();
    await handler(
      makeReq({
        storeLocation: store.name,
        items: [{ productId: product.id, quantity: 1, unitPrice: 1000 }],
      }),
      res,
      session,
    );

    const payload = res.body as { id: number; taxAmount: number };
    const order = await prisma.salesOrder.findUnique({
      where: { id: payload.id },
      select: { totalTax: true },
    });
    expect(Number(order?.totalTax ?? 0)).toBe(payload.taxAmount);
  });

  // The bug this refactor fixes: a store outside the deployment's default
  // district used to charge zero tax (the resolver only ever looked for
  // `shortName: "CT"`). This proves a second store, in a second district,
  // charges ITS OWN rate -- not CT's, and not zero.
  it("charges a second store's own district rate, not the first store's", async () => {
    await seedCatalogAndTax(); // CT district + "Test Store" exist but are unused below

    const nyGroup = await prisma.taxGroup.create({ data: { name: "NY Standard Retail" } });
    const nyDistrict = await prisma.taxDistrict.create({
      data: { shortName: "NY", state: "NY", name: "New York State Sales Tax", isActive: true },
    });
    await prisma.taxRule.create({
      data: { districtId: nyDistrict.id, groupId: nyGroup.id, taxRate: 0.08, sortOrder: 0 },
    });
    const nyStore = await prisma.storeLocation.create({
      data: { name: "NY Store", code: "NYS", type: "STORE", taxDistrictId: nyDistrict.id },
    });
    const product = await prisma.product.findFirstOrThrow({ where: { productNumber: "SOFA-1" } });

    const res = makeRes();
    await handler(
      makeReq({
        storeLocation: nyStore.name,
        items: [{ productId: product.id, quantity: 1, unitPrice: 1000 }],
      }),
      res,
      session,
    );

    expect(res.statusCode).toBe(201);
    const payload = res.body as { id: number; total: number; taxAmount: number };
    // 1000 * 8% = 80, NOT 63.50 (CT's rate) and NOT 0 (the pre-fix bug).
    expect(payload.taxAmount).toBe(80);
    expect(payload.total).toBe(1080);
    expect(await recordedTotal(payload.id)).toBe(payload.total);

    const order = await prisma.salesOrder.findUnique({
      where: { id: payload.id },
      select: { taxDistrictId: true },
    });
    expect(order?.taxDistrictId).toBe(nyDistrict.id);
  });
});
