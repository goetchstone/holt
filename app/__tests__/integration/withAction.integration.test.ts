// /app/__tests__/integration/withAction.integration.test.ts
//
// A handheld action done once however many times it is sent
// (lib/inventory/withAction.ts), against real Postgres.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { postMovement } from "@/lib/inventory/ledger";
import { withAction, parseActionKey, ActionKeyError } from "@/lib/inventory/withAction";

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "P",
      name: "P",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "S", code: "S", type: "STORE" },
  });
  const place = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "A", name: "A" },
  });
  return {
    product,
    place: { storeLocationId: store.id, stockLocationId: place.id, salesOrderId: null },
  };
}

describe("withAction (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const receive =
    (
      productId: number,
      place: { storeLocationId: number; stockLocationId: number; salesOrderId: null },
    ) =>
    (tx: Parameters<Parameters<typeof withAction>[2]>[0], actionKey: string) =>
      postMovement(tx, { productId, quantity: 2, to: place, reason: "OPENING", actionKey }).then(
        () => ({
          moved: 2,
        }),
      );

  it("does the work once and answers a resend with the first answer", async () => {
    const { product, place } = await world();
    const first = await withAction("scan-0001-abc", { kind: "TEST" }, receive(product.id, place));
    const again = await withAction("scan-0001-abc", { kind: "TEST" }, receive(product.id, place));
    expect(first).toEqual({ result: { moved: 2 }, replayed: false });
    expect(again).toEqual({ result: { moved: 2 }, replayed: true });
    const moves = await prisma.stockMovement.findMany({ where: { productId: product.id } });
    expect(moves).toHaveLength(1);
    expect(moves[0].actionKey).toBe("scan-0001-abc");
  });

  it("two copies racing each other move the stock once", async () => {
    const { product, place } = await world();
    const results = await Promise.all([
      withAction("scan-race-0001", { kind: "TEST" }, receive(product.id, place)),
      withAction("scan-race-0001", { kind: "TEST" }, receive(product.id, place)),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await prisma.stockMovement.count({ where: { productId: product.id } })).toBe(1);
  });

  it("an action that fails leaves no key behind, so the resend does the work", async () => {
    const { product, place } = await world();
    await expect(
      withAction("scan-fail-0001", { kind: "TEST" }, async () => {
        throw new Error("printer jammed");
      }),
    ).rejects.toThrow("printer jammed");
    const retry = await withAction("scan-fail-0001", { kind: "TEST" }, receive(product.id, place));
    expect(retry.replayed).toBe(false);
  });

  it("refuses a missing or malformed key", () => {
    expect(parseActionKey(undefined)).toBeInstanceOf(ActionKeyError);
    expect(parseActionKey("short")).toBeInstanceOf(ActionKeyError);
    expect(parseActionKey("has spaces in it")).toBeInstanceOf(ActionKeyError);
    expect(parseActionKey("a1b2c3d4-e5f6")).toBe("a1b2c3d4-e5f6");
  });
});
