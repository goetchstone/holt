// /app/__tests__/integration/costUnreadPayloads.integration.test.ts
//
// SEC-14 (2026-10-01): routes whose screens never read what the store paid stop
// sending it, to everyone. Each route here returned cost because it handed out
// whole rows (an order line's cost, a product's baseCost), and each caller was
// read: no screen used the field. The consignment stats route also answered
// with cost sums under names the Reconciliation page does not read, so its
// four count cards were blank.
//
// Real routes, real permission gates, real database; next-auth's session is the
// only mock. Every response is checked at every depth for a cost key, and for
// the fields its screen does read.

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
import customerRoute from "@/pages/api/customers/[id]/index";
import interactionRoute from "@/pages/api/interactions/[id]";
import runRoute from "@/pages/api/dispatch/runs/[id]";
import stopsRoute from "@/pages/api/dispatch/runs/[id]/stops";
import pickListsRoute from "@/pages/api/dispatch/pick-lists/index";
import pickListRoute from "@/pages/api/dispatch/pick-lists/[id]";
import orderRoute from "@/pages/api/sales/orders/[id]";
import varianceRoute from "@/pages/api/inventory/product-variance/[externalId]";
import consignmentStatsRoute from "@/pages/api/consignment/stats";

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(
  route: Route,
  { method = "GET", query = {}, body = {} }: { method?: string; query?: object; body?: object },
) {
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
  // What the client receives: Decimals and Dates as JSON.
  return { status, body: JSON.parse(JSON.stringify(payload ?? null)) };
}

/** Every key at every depth whose name says cost. */
function costKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => costKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/cost|riser|framePrice|pricePerSq/i.test(k) ? [`${path}.${k}`] : []),
      ...costKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

const w: Record<string, { id: number }> = {};

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });

  await prisma.user.create({ data: { id: "admin", email: "admin@example.com" } });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  w.admin = await prisma.staffMember.create({
    data: {
      userId: "admin",
      displayName: "Admin",
      email: "admin@example.com",
      role: "ADMIN",
      roleId: adminRole.id,
      isActive: true,
    },
  });

  const store = await prisma.storeLocation.create({
    data: { name: "Main Street", code: "MAIN", type: "STORE" },
  });
  const vendor = await prisma.vendor.create({ data: { name: "Quarry Hill" } });
  w.vendor = vendor;
  const department = await prisma.department.create({ data: { name: "Living Room" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  w.product = await prisma.product.create({
    data: {
      productNumber: "QH-SOFA-01",
      name: "Quarry Sofa",
      externalId: 9001,
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseCost: 400,
      baseRetail: 1000,
    },
  });
  w.customer = await prisma.customer.create({ data: { firstName: "Marion", lastName: "Webb" } });
  w.order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-COST-1",
      status: "ORDER",
      orderDate: new Date("2026-09-30T15:00:00Z"),
      customerId: w.customer.id,
      storeLocation: store.name,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: w.product.id,
            productName: "Quarry Sofa",
            orderedQuantity: 1,
            netPrice: 1000,
            cost: 400,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
  w.interaction = await prisma.customerInteraction.create({
    data: {
      staffMemberId: w.admin.id,
      customerId: w.customer.id,
      salesOrderId: w.order.id,
      storeLocation: store.name,
    },
  });
  const vehicle = await prisma.vehicle.create({ data: { name: "Box Truck 1" } });
  const appointment = await prisma.serviceAppointment.create({
    data: {
      appointmentNumber: "APPT-COST-1",
      type: "DELIVERY",
      status: "SCHEDULED",
      salesOrderId: w.order.id,
      customerId: w.customer.id,
      storeLocationId: store.id,
      scheduledDate: new Date("2026-10-01T15:00:00Z"),
    },
  });
  w.run = await prisma.deliveryRun.create({
    data: {
      runNumber: "RUN-COST-1",
      runDate: new Date("2026-10-01T00:00:00Z"),
      vehicleId: vehicle.id,
      status: "PLANNING",
    },
  });
  await prisma.deliveryStop.create({
    data: {
      deliveryRunId: w.run.id,
      serviceAppointmentId: appointment.id,
      stopOrder: 1,
      status: "PENDING",
    },
  });

  const items: Array<[string, "ON_FLOOR" | "ON_APPROVAL" | "SOLD" | "MISSING"]> = [
    ["CN-1", "ON_FLOOR"],
    ["CN-2", "ON_FLOOR"],
    ["CN-3", "ON_APPROVAL"],
    ["CN-4", "SOLD"],
    ["CN-5", "MISSING"],
  ];
  for (const [barcode, status] of items) {
    await prisma.consignmentItem.create({
      data: { vendorId: vendor.id, barcode, cost: 250, status },
    });
  }

  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: "admin", email: "admin@example.com" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("routes whose screens never read cost send none", () => {
  it("customer detail: orders keep netPrice and vatAmount, lose cost", async () => {
    const { status, body } = await call(customerRoute, { query: { id: String(w.customer.id) } });
    expect(status).toBe(200);
    expect(body.salesOrders[0].lineItems[0]).toMatchObject({ netPrice: "1000", vatAmount: "0" });
    expect(costKeys(body)).toEqual([]);
  });

  it("interaction detail", async () => {
    const { status, body } = await call(interactionRoute, {
      query: { id: String(w.interaction.id) },
    });
    expect(status).toBe(200);
    expect(body.salesOrder.lineItems[0]).toMatchObject({
      productName: "Quarry Sofa",
      netPrice: 1000,
    });
    expect(costKeys(body)).toEqual([]);
  });

  it("delivery run and its stops: drivers keep product name and quantity", async () => {
    for (const route of [runRoute, stopsRoute]) {
      const { status, body } = await call(route, { query: { id: String(w.run.id) } });
      expect(status).toBe(200);
      const line = body.stops[0].serviceAppointment.salesOrder.lineItems[0];
      expect(line).toMatchObject({ productName: "Quarry Sofa", orderedQuantity: "1" });
      expect(costKeys(body)).toEqual([]);
    }
  });

  it("pick lists, created and read: names and numbers, never whole product rows", async () => {
    const created = await call(pickListsRoute, {
      method: "POST",
      body: { deliveryRunId: String(w.run.id) },
    });
    expect(created.status).toBe(201);
    expect(created.body.items[0].product).toEqual({
      id: w.product.id,
      name: "Quarry Sofa",
      productNumber: "QH-SOFA-01",
    });
    expect(costKeys(created.body)).toEqual([]);

    const perOrder = await call(pickListsRoute, {
      method: "POST",
      body: { salesOrderId: String(w.order.id) },
    });
    expect(perOrder.status).toBe(201);
    expect(costKeys(perOrder.body)).toEqual([]);

    const read = await call(pickListRoute, { query: { id: String(created.body.id) } });
    expect(read.status).toBe(200);
    expect(read.body.items[0].orderLineItem).toEqual({
      id: expect.any(Number),
      productName: "Quarry Sofa",
    });
    expect(costKeys(read.body)).toEqual([]);
  });

  it("order detail", async () => {
    const { status, body } = await call(orderRoute, { query: { id: String(w.order.id) } });
    expect(status).toBe(200);
    expect(body.lineItems[0]).toMatchObject({ productName: "Quarry Sofa", netPrice: 1000 });
    expect(costKeys(body)).toEqual([]);
  });

  it("product count variance: the product's name and number only", async () => {
    const { status, body } = await call(varianceRoute, { query: { externalId: "9001" } });
    expect(status).toBe(200);
    expect(body.product).toEqual({
      id: w.product.id,
      name: "Quarry Sofa",
      productNumber: "QH-SOFA-01",
    });
    expect(costKeys(body)).toEqual([]);
  });
});

describe("consignment stats", () => {
  it("answers the four counts the Reconciliation page shows, not cost sums", async () => {
    const { status, body } = await call(consignmentStatsRoute, {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ onFloor: 2, onApproval: 1, soldUnpaid: 1, missing: 1 });
    expect(costKeys(body)).toEqual([]);
  });
});
