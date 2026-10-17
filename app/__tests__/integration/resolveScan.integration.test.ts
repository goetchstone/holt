// /app/__tests__/integration/resolveScan.integration.test.ts
//
// What a scan is, against real Postgres (lib/scan/resolveScan.ts): Holt's own
// place and box labels first, then a UPC, a consignment rug's barcode, a
// product number, and a place's own code at the scanner's store.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { resolveScan } from "@/lib/scan/resolveScan";
import { placeContents, productStock } from "@/lib/scan/lookup";
import { placeLabelFields } from "@/lib/labels/placeLabel";
import { stockAt } from "../helpers/stock";

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id },
  });
  const product = (productNumber: string, extra: object = {}) =>
    prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
        ...extra,
      },
    });
  const sofa = await product("SOFA-1", { boxesPerUnit: 3 });
  const rug = await product("RUG-1");
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const barn = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "BARN", name: "North Barn", locationType: "GROUP" },
  });
  const bay = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "BAY-3", name: "Bay 3", parentId: barn.id },
  });
  await prisma.upc.create({ data: { upc: "0123456789AB", productId: sofa.id } });
  await prisma.consignmentItem.create({
    data: { barcode: "M1000-01", productId: rug.id, vendorId: vendor.id, cost: 500 },
  });
  return { sofa, rug, store, barn, bay };
}

describe("resolving a scan (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reads a place label, with the place's path", async () => {
    const { bay } = await world();
    const r = await resolveScan(prisma, `L-${bay.id}`);
    expect(r).toMatchObject({
      kind: "place",
      place: { id: bay.id, path: "North Barn › Bay 3", holdsStock: true },
    });
    expect(await resolveScan(prisma, "L-999999")).toMatchObject({ kind: "unknown" });
  });

  it("reads a box label, with the product's boxes per unit", async () => {
    const { sofa } = await world();
    expect(await resolveScan(prisma, `B-${sofa.id}-2-3`)).toMatchObject({
      kind: "product",
      via: "box",
      product: { id: sofa.id, boxesPerUnit: 3 },
      box: { box: 2, of: 3 },
    });
  });

  it("looks text up as a UPC, then a product number, then the store's own place code", async () => {
    const { sofa, rug, store, bay } = await world();
    expect(await resolveScan(prisma, "0123456789ab")).toMatchObject({
      kind: "product",
      via: "upc",
      product: { id: sofa.id },
    });
    expect(await resolveScan(prisma, "rug-1")).toMatchObject({
      kind: "product",
      via: "productNumber",
      product: { id: rug.id, boxesPerUnit: 1 },
    });
    expect(await resolveScan(prisma, "bay-3", { storeLocationId: store.id })).toMatchObject({
      kind: "place",
      place: { id: bay.id },
    });
    expect(await resolveScan(prisma, "M1000-01")).toMatchObject({
      kind: "product",
      via: "consignment",
      product: { id: rug.id },
    });
    // Without the store, a place code is not guessed at across stores.
    expect(await resolveScan(prisma, "bay-3")).toMatchObject({ kind: "unknown" });
  });

  it("shows where a product sits and what a place holds, free and committed", async () => {
    const { sofa, store, barn, bay } = await world();
    await stockAt({
      productId: sofa.id,
      storeLocationId: store.id,
      stockLocationId: bay.id,
      quantity: 2,
    });
    const stock = await productStock(prisma, sofa.id);
    expect(stock).toEqual([
      expect.objectContaining({
        placeId: bay.id,
        placePath: "North Barn › Bay 3",
        free: 2,
        committed: 0,
      }),
    ]);
    // A group shows what is in the places inside it.
    const contents = await placeContents(prisma, barn);
    expect(contents).toEqual([expect.objectContaining({ productId: sofa.id, free: 2 })]);
  });

  it("a place's label carries its code, name, path and the L-<id> barcode", async () => {
    const { bay } = await world();
    expect((await placeLabelFields(prisma, bay.id)).fields).toEqual({
      locationCode: "BAY-3",
      locationName: "Bay 3",
      path: "North Barn › Bay 3",
      store: "Mill",
      barcode: `L-${bay.id}`,
    });
  });
});
