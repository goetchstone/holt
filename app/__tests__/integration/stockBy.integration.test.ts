// /app/__tests__/integration/stockBy.integration.test.ts
//
// Stock and space by any field (ledger plan phase 13) against real Postgres:
// the report counts every unit inside the place or store asked about, groups it
// by the field asked for, and splits each measured place's floor over the
// units in it (lib/reports/stockBy.ts).

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { getStockBy, UNMEASURED } from "@/lib/reports/stockBy";
import { handler as stockByHandler } from "@/pages/api/reports/stock-by";
import { stockAt } from "../helpers/stock";

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as any,
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
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: any };
}

// Mill Shop: North Barn (GROUP, 1000 sq ft) > Sofas bay, Rugs bay; Front floor
// (FLOOR, 400 sq ft). Harbour: one unmeasured back room.
async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "Weaver", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Upholstery" } });
  const sofasCat = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, trackInventory: true },
  });
  const rugsCat = await prisma.category.create({
    data: { name: "Rugs", departmentId: department.id, trackInventory: true },
  });
  const product = (productNumber: string, categoryId: number) =>
    prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId,
      },
    });
  const sofa = await product("SOFA", sofasCat.id);
  const rug = await product("RUG", rugsCat.id);

  const mill = await prisma.storeLocation.create({
    data: { name: "Mill Shop", code: "MILL", type: "STORE" },
  });
  const harbour = await prisma.storeLocation.create({
    data: { name: "Harbour", code: "HARB", type: "STORE" },
  });
  const barn = await prisma.stockLocation.create({
    data: {
      storeLocationId: mill.id,
      code: "BARN",
      name: "North Barn",
      locationType: "GROUP",
      squareFootage: 1000,
    },
  });
  const place = (storeLocationId: number, code: string, extra: object = {}) =>
    prisma.stockLocation.create({ data: { storeLocationId, code, name: code, ...extra } });
  const sofaBay = await place(mill.id, "SOFA-BAY", { parentId: barn.id });
  const rugBay = await place(mill.id, "RUG-BAY", { parentId: barn.id });
  const front = await place(mill.id, "FRONT", { locationType: "FLOOR", squareFootage: 400 });
  const back = await place(harbour.id, "HARB-BACK");

  const at = (
    productId: number,
    storeLocationId: number,
    stockLocationId: number,
    quantity: number,
  ) => stockAt({ productId, storeLocationId, stockLocationId, quantity });
  await at(sofa.id, mill.id, sofaBay.id, 3);
  await at(rug.id, mill.id, rugBay.id, 1);
  await at(rug.id, harbour.id, back.id, 5);
  // FRONT holds nothing: its 400 sq ft is empty space.
  return { mill, harbour, barn, sofaBay, front };
}

describe("stock and space by any field (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("looking at everything, places inside it are the stores", async () => {
    await world();
    const { rows } = await getStockBy(prisma, {}, "place");
    expect(rows).toEqual([
      { group: "Mill Shop", units: 4, squareFeet: 1000 },
      { group: "Harbour", units: 5, squareFeet: 0 },
      { group: "Empty space", units: 0, squareFeet: 400 },
      { group: UNMEASURED, units: 5, squareFeet: 0 },
    ]);
  });

  it("inside a building, the barn's floor is split over the bays inside it by unit", async () => {
    const { barn } = await world();
    const { rows, warnings } = await getStockBy(prisma, { stockLocationId: barn.id }, "place");
    expect(rows).toEqual([
      { group: "SOFA-BAY", units: 3, squareFeet: 750 },
      { group: "RUG-BAY", units: 1, squareFeet: 250 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("inside a store, by a product field, only that store's stock", async () => {
    const { mill } = await world();
    const { rows } = await getStockBy(prisma, { storeLocationId: mill.id }, "category");
    expect(rows).toEqual([
      { group: "Sofas", units: 3, squareFeet: 750 },
      { group: "Rugs", units: 1, squareFeet: 250 },
      { group: "Empty space", units: 0, squareFeet: 400 },
    ]);
  });

  it("a committed unit still takes up floor", async () => {
    const { mill, sofaBay } = await world();
    const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-1",
        status: "ORDER",
        orderDate: new Date(),
        customerId: customer.id,
        storeLocation: mill.name,
      },
    });
    const sofa = await prisma.product.findFirstOrThrow({ where: { productNumber: "SOFA" } });
    await stockAt({
      productId: sofa.id,
      storeLocationId: mill.id,
      stockLocationId: sofaBay.id,
      salesOrderId: order.id,
      quantity: 1,
    });
    const { rows } = await getStockBy(prisma, { stockLocationId: sofaBay.id }, "category");
    expect(rows).toEqual([
      { group: "Sofas", units: 4, squareFeet: 0 },
      { group: UNMEASURED, units: 4, squareFeet: 0 },
    ]);
  });

  it("warns when a measured place sits inside a measured place", async () => {
    const { barn, sofaBay } = await world();
    await prisma.stockLocation.update({ where: { id: sofaBay.id }, data: { squareFootage: 200 } });
    const { warnings } = await getStockBy(prisma, { stockLocationId: barn.id }, "place");
    expect(warnings).toEqual([
      expect.stringContaining('"SOFA-BAY" has square footage and is inside "North Barn"'),
    ]);
  });

  it("the route refuses an unknown field and a place at another store than the one named", async () => {
    const { harbour, sofaBay } = await world();
    const bad = makeRes();
    await stockByHandler(
      { method: "GET", query: { by: "colour" }, headers: {} } as unknown as NextApiRequest,
      bad,
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toContain("placeType");

    const mismatch = makeRes();
    await stockByHandler(
      {
        method: "GET",
        query: {
          by: "place",
          storeLocationId: String(harbour.id),
          stockLocationId: String(sofaBay.id),
        },
        headers: {},
      } as unknown as NextApiRequest,
      mismatch,
    );
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body.error).toContain("different store");

    const ok = makeRes();
    await stockByHandler(
      { method: "GET", query: { by: "vendor" }, headers: {} } as unknown as NextApiRequest,
      ok,
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.body.rows[0]).toEqual({ group: "Weaver", units: 9, squareFeet: 1000 });
  });
});
