// /app/__tests__/integration/handover.integration.test.ts
//
// "Is this order delivered?" had no answer before markHandedOver().
//
// Three fulfilment methods each recorded the moment somewhere different --
// DELIVERY on DeliveryStop.completedAt, PICKUP on SalesOrder.dispatchStatus,
// TAKEN nowhere at all -- while SalesOrder.status moved independently of all of
// them from a dropdown. Two FULFILLED flags, written by two endpoints, neither
// writing the other's field, so an order could sit disagreeing with itself
// indefinitely and no report could tell which one to believe.
//
// The worst of it: a signed, photographed, physically completed delivery left
// the SalesOrder entirely untouched. Still ORDER, stock still committed, money
// still a deposit, forever, unless somebody separately clicked a different
// button on a different screen.
//
// These tests pin the one fact and its consequences.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { markHandedOver, handoverMethodFor } from "@/lib/fulfilment/handover";
import { availableQuantity } from "@/lib/inventory/allocation";
import { isValidStopTransition } from "@/lib/deliveryService";

const NOW = new Date();

async function seedOrderWithStock(orderno: string, deliveryMethod?: string) {
  const store = await prisma.storeLocation.upsert({
    where: { code: "MAIN" },
    update: {},
    create: { name: "Main Street", code: "MAIN", type: "STORE" },
  });
  const vendor = await prisma.vendor.upsert({
    where: { name: "Northfield" },
    update: {},
    create: { name: "Northfield", code: "NF", pricingModel: "FLAT" },
  });
  const department = await prisma.department.upsert({
    where: { name: "Living Room" },
    update: {},
    create: { name: "Living Room" },
  });
  const category = await prisma.category.upsert({
    where: { name_departmentId: { name: "Sofas", departmentId: department.id } },
    update: {},
    create: { name: "Sofas", departmentId: department.id },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: `P-${orderno}`,
      name: "Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const customer = await prisma.customer.create({
    data: { firstName: "Handover", lastName: "Test" },
  });
  const order = await prisma.salesOrder.create({
    data: {
      orderno,
      status: "ORDER",
      orderDate: NOW,
      customerId: customer.id,
      storeLocation: store.name,
      storeLocationId: store.id,
      ...(deliveryMethod ? { deliveryMethod: deliveryMethod as never } : {}),
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: product.id,
            productName: "Sofa",
            orderedQuantity: 1,
            netPrice: 1000,
            cost: 500,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
  // Stock allocated to this order -- what a handover has to consume.
  await prisma.inventoryPosition.create({
    data: {
      productId: product.id,
      storeLocationId: store.id,
      quantity: 1,
      salesOrderId: order.id,
    },
  });
  return { order, product, store, customer };
}

describe("handover is one fact (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("records the delivery and everything that follows from it", async () => {
    const { order, product, store } = await seedOrderWithStock("SO-H1");

    const before = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(before.deliveredAt).toBeNull();

    const at = new Date("2026-07-14T15:00:00Z");
    const result = await prisma.$transaction((tx) =>
      markHandedOver(tx, { salesOrderId: order.id, at, method: "DELIVERY", actor: "driver" }),
    );
    expect(result.changed).toBe(true);

    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.deliveredAt).toEqual(at);

    // BOTH flags, together. This is the pair that used to disagree.
    expect(after.status).toBe("FULFILLED");
    expect(after.dispatchStatus).toBe("FULFILLED");

    // The goods left the building, so the stock did too. A completed delivery
    // never called consume() before, so delivered stock stayed on the books.
    const held = await prisma.inventoryPosition.findMany({
      where: { salesOrderId: order.id },
    });
    expect(held).toHaveLength(0);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(0);

    const log = await prisma.orderChangeLog.findFirst({
      where: { salesOrderId: order.id, changeType: "HANDED_OVER" },
    });
    expect(log?.newValue).toContain("DELIVERY");
  });

  it("is idempotent, because a truck's connection is not", async () => {
    // The driver app fires stop-complete and run-complete as separate requests
    // and retries are routine. Consuming stock twice would relieve inventory
    // the business still owns.
    const { order } = await seedOrderWithStock("SO-H2");
    const at = new Date("2026-07-14T15:00:00Z");

    const first = await prisma.$transaction((tx) =>
      markHandedOver(tx, { salesOrderId: order.id, at, method: "DELIVERY" }),
    );
    const second = await prisma.$transaction((tx) =>
      markHandedOver(tx, {
        salesOrderId: order.id,
        at: new Date("2026-07-20T09:00:00Z"),
        method: "DELIVERY",
      }),
    );

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    // The FIRST handover date stands. A retry must not move the revenue date.
    expect(second.deliveredAt).toEqual(at);

    const logs = await prisma.orderChangeLog.findMany({
      where: { salesOrderId: order.id, changeType: "HANDED_OVER" },
    });
    expect(logs).toHaveLength(1);
  });

  it("treats a pickup and a take-with as the same event as a delivery", async () => {
    // All three are "the goods reached the customer". Only the method differs,
    // and it is recorded rather than inferred.
    for (const [orderno, method] of [
      ["SO-H3", "PICKUP"],
      ["SO-H4", "TAKEN"],
    ] as const) {
      const { order } = await seedOrderWithStock(orderno, method);
      await prisma.$transaction((tx) =>
        markHandedOver(tx, { salesOrderId: order.id, at: NOW, method }),
      );
      const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.deliveredAt).not.toBeNull();
      expect(after.status).toBe("FULFILLED");
      expect(after.dispatchStatus).toBe("FULFILLED");
      expect(after.deliveryMethod).toBe(method);
    }
  });

  it("resolves the method from what the order recorded", () => {
    expect(handoverMethodFor("TAKEN")).toBe("TAKEN");
    expect(handoverMethodFor("PICKUP")).toBe("PICKUP");
    expect(handoverMethodFor("DELIVERY")).toBe("DELIVERY");
    // Nobody said, so assume the one that leaves a record to check.
    expect(handoverMethodFor(null)).toBe("DELIVERY");
    expect(handoverMethodFor(undefined)).toBe("DELIVERY");
  });
});

describe("a stop that could not be delivered goes back on the queue", () => {
  it("has no FAILED state to be abandoned in", () => {
    // FAILED conflated two different things and served neither: a delivery that
    // has not happened yet (reschedule it) and goods sent back after delivery
    // (a Return with a pickup). As a terminal state it was worse than useless --
    // the driver UI skipped FAILED stops when picking the next one, so one
    // would be silently abandoned: never delivered, never invoiced, nobody told.
    expect(isValidStopTransition("ARRIVED", "COMPLETED")).toBe(true);
    expect(isValidStopTransition("ARRIVED", "PENDING")).toBe(true);
    expect(isValidStopTransition("EN_ROUTE", "PENDING")).toBe(true);

    // COMPLETED is terminal because handing goods over is not undoable: it sets
    // deliveredAt, which recognises the sale.
    expect(isValidStopTransition("COMPLETED", "PENDING")).toBe(false);

    // And the skipped transition the endpoint used to accept unchecked.
    expect(isValidStopTransition("PENDING", "COMPLETED")).toBe(false);
  });
});
