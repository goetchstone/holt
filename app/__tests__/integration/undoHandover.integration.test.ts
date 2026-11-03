// /app/__tests__/integration/undoHandover.integration.test.ts
//
// GAP-07: a handover recorded by mistake is undone (owner, 2026-11-03: a
// manager's permission; refused once commission on the order is paid out).
//
// Before: handing over was terminal (deliveryService.ts) and nothing reversed
// it. The order screen's status buttons could move a delivered order back to
// ORDER, but that left its goods off the books and deliveredAt set: an "open"
// order whose stock had left. Now markHandedOver records what each handover
// changes (OrderHandover) and tags the units it moves, and the undo reverses
// exactly that; the status buttons refuse to skip it.
//
// Real routes, real database; the drift check after every test
// (jest.integration.afterEach.ts) holds the stock journal to the balance.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { loadRun, pickUnits } from "@/lib/fulfilment/pick";
import { setRunStatus } from "@/lib/fulfilment/runs";
import { completeStop } from "@/lib/fulfilment/stops";
import { UNASSIGNED_DELIVERY_WHERE } from "@/lib/deliveryService";
import undoRoute, { handler as undo } from "@/pages/api/sales/orders/[id]/undo-handover";
import { handler as orderRoute } from "@/pages/api/sales/orders/[id]";
import { handler as dispatchRoute } from "@/pages/api/sales/orders/[id]/dispatch";
import { stockAt } from "../helpers/stock";

const sessionMock = getServerSession as jest.Mock;
const manager = { user: { id: "mgr", email: "mgr@example.com" } } as unknown as Session;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
  const res = {
    statusCode: 200,
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
  };
  return res as unknown as TestRes;
}

function req(method: string, query: Record<string, string>, body?: unknown) {
  return { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest;
}

type Handler = (req: NextApiRequest, res: NextApiResponse, session: Session) => unknown;

async function as(handler: Handler, method: string, query: Record<string, string>, body?: unknown) {
  const res = makeRes();
  await handler(req(method, query, body), res, manager);
  return res;
}

const undoIt = (orderId: number, reason = "Completed the wrong stop") =>
  as(undo, "POST", { id: String(orderId) }, { reason });

async function world(deliveryMethod: "DELIVERY" | "TAKEN" = "DELIVERY") {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id, trackInventory: true },
  });
  const product = (productNumber: string) =>
    prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
  const lamp = await product("LAMP");
  const sofa = await product("SOFA");
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const shelf = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "SHELF", name: "Shelf" },
  });
  const dock = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "DOCK", name: "Loading Bay", locationType: "STAGING" },
  });
  const designer = await prisma.staffMember.create({
    data: { displayName: "Dana Reyes", isDesigner: true, isActive: true },
  });
  const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-1",
      status: "ORDER",
      // Not SCHEDULED_DELIVERY: an undo with no record of it would fall back to
      // that, and pass by accident.
      dispatchStatus: "RECEIVED_IN_WAREHOUSE",
      orderDate: new Date("2026-03-10T15:00:00Z"),
      customerId: customer.id,
      salesPersonId: designer.id,
      salesperson: designer.displayName,
      storeLocation: "Mill",
      storeLocationId: store.id,
      deliveryMethod,
      lineItems: {
        create: [
          { lineNumber: 1, productId: lamp.id, orderedQuantity: 2, netPrice: 200, cost: 80 },
          { lineNumber: 2, productId: sofa.id, orderedQuantity: 1, netPrice: 2000, cost: 900 },
        ],
      },
    },
    include: { lineItems: { orderBy: { lineNumber: "asc" } } },
  });
  for (const [p, q] of [
    [lamp.id, 2],
    [sofa.id, 1],
  ] as const) {
    await stockAt({
      productId: p,
      storeLocationId: store.id,
      stockLocationId: shelf.id,
      quantity: q,
      salesOrderId: order.id,
    });
  }
  const vehicle = await prisma.vehicle.create({ data: { name: "Truck 1" } });
  const run = await prisma.deliveryRun.create({
    data: { runNumber: "DR-1", runDate: new Date(), vehicleId: vehicle.id, status: "PLANNING" },
  });
  const appointment = await prisma.serviceAppointment.create({
    data: {
      appointmentNumber: "APPT-1",
      type: "DELIVERY",
      status: "SCHEDULED",
      salesOrderId: order.id,
      customerId: customer.id,
      storeLocationId: store.id,
      scheduledDate: new Date(),
    },
  });
  const stop = await prisma.deliveryStop.create({
    data: { deliveryRunId: run.id, serviceAppointmentId: appointment.id, stopOrder: 1 },
  });
  return { lamp, sofa, store, shelf, dock, designer, order, run, appointment, stop };
}

type World = Awaited<ReturnType<typeof world>>;

/** Everything to the dock, onto the truck, out on the run. */
async function loadAndGo(w: World) {
  for (const [productId, units] of [
    [w.lamp.id, 2],
    [w.sofa.id, 1],
  ] as const) {
    await prisma.$transaction((tx) =>
      pickUnits(tx, {
        deliveryRunId: w.run.id,
        salesOrderId: w.order.id,
        productId,
        units,
        fromStockLocationId: w.shelf.id,
        toStockLocationId: w.dock.id,
        actor: null,
      }),
    );
  }
  await prisma.$transaction((tx) => loadRun(tx, w.run.id, "loader"));
  await prisma.$transaction((tx) => setRunStatus(tx, w.run.id, "IN_PROGRESS", "desk"));
}

async function committed(w: World, stockLocationId: number) {
  const rows = await prisma.inventoryPosition.findMany({
    where: { stockLocationId, salesOrderId: w.order.id },
    orderBy: { productId: "asc" },
  });
  return rows.map((r) => [r.productId, Number(r.quantity)]);
}

const orderNow = (w: World) =>
  prisma.salesOrder.findUniqueOrThrow({
    where: { id: w.order.id },
    select: {
      status: true,
      dispatchStatus: true,
      deliveredAt: true,
      lineItems: { orderBy: { lineNumber: "asc" }, select: { fulfilledQty: true } },
    },
  });

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("undoing a delivery off a run's truck", () => {
  it("brings the units back to the loading bay, reopens the order, and puts the delivery back in dispatch", async () => {
    const w = await world();
    await loadAndGo(w);
    await prisma.$transaction((tx) =>
      completeStop(tx, w.stop.id, { at: new Date(), actor: "driver" }),
    );
    // The run finishes: its truck place leaves service.
    await prisma.$transaction((tx) => setRunStatus(tx, w.run.id, "COMPLETED", "desk"));
    expect(await committed(w, w.dock.id)).toEqual([]);

    const res = await undoIt(w.order.id);
    expect([res.statusCode, res.body.unitsBack]).toEqual([200, 3]);

    // Back where an unloaded truck puts them, still this order's.
    expect(await committed(w, w.dock.id)).toEqual([
      [w.lamp.id, 2],
      [w.sofa.id, 1],
    ]);
    const after = await orderNow(w);
    expect(after).toEqual({
      status: "ORDER",
      dispatchStatus: "RECEIVED_IN_WAREHOUSE",
      deliveredAt: null,
      lineItems: [{ fulfilledQty: expect.anything() }, { fulfilledQty: expect.anything() }],
    });
    expect(after.lineItems.map((l) => Number(l.fulfilledQty))).toEqual([0, 0]);

    // Off the run, pending in the dispatch pool, with why.
    expect(await prisma.deliveryStop.findUnique({ where: { id: w.stop.id } })).toBeNull();
    const appt = await prisma.serviceAppointment.findUniqueOrThrow({
      where: { id: w.appointment.id },
    });
    expect([appt.status, appt.notes]).toEqual(["PENDING", expect.stringMatching(/wrong stop/)]);
    expect(
      await prisma.serviceAppointment.count({
        where: { ...UNASSIGNED_DELIVERY_WHERE, id: w.appointment.id },
      }),
    ).toBe(1);

    const handover = await prisma.orderHandover.findFirstOrThrow({
      where: { salesOrderId: w.order.id },
    });
    expect([handover.undoneBy, handover.undoReason]).toEqual([
      "mgr@example.com",
      "Completed the wrong stop",
    ]);
    expect(
      await prisma.stockMovement.count({
        where: { orderHandoverId: handover.id, reason: "UNDELIVER" },
      }),
    ).toBe(2);
    expect(
      (
        await prisma.orderChangeLog.findMany({
          where: { salesOrderId: w.order.id, changeType: "HANDOVER_UNDONE" },
        })
      ).map((l) => l.reason),
    ).toEqual(["Completed the wrong stop"]);

    // Done once: there is nothing left to undo.
    expect((await undoIt(w.order.id)).statusCode).toBe(409);
  });

  it("leaves a part delivery before it delivered, and puts back only what the handover moved", async () => {
    const w = await world();
    await loadAndGo(w);
    // One lamp went on the run; the rest stayed on the truck.
    await prisma.$transaction((tx) =>
      completeStop(tx, w.stop.id, {
        at: new Date(),
        delivered: [{ orderLineItemId: w.order.lineItems[0].id, quantity: 1 }],
        actor: "driver",
      }),
    );
    // Then the rest marked handed over from the order screen.
    const handedOver = await as(
      orderRoute,
      "PUT",
      { id: String(w.order.id) },
      { status: "FULFILLED" },
    );
    expect(handedOver.statusCode).toBe(200);
    expect((await orderNow(w)).lineItems.map((l) => Number(l.fulfilledQty))).toEqual([2, 1]);

    expect((await undoIt(w.order.id)).body.unitsBack).toBe(2);
    // The lamp delivered on the run stays delivered; the other lamp and the
    // sofa are back on the truck, still running.
    expect((await orderNow(w)).lineItems.map((l) => Number(l.fulfilledQty))).toEqual([1, 0]);
    const truck = await prisma.stockLocation.findFirstOrThrow({
      where: { deliveryRunId: w.run.id },
    });
    expect(await committed(w, truck.id)).toEqual([
      [w.lamp.id, 1],
      [w.sofa.id, 1],
    ]);
  });
});

describe("undoing a take-with at the counter", () => {
  it("puts the units back on the shelf they left, and a handed-over order's status buttons send you here", async () => {
    const w = await world("TAKEN");
    const id = String(w.order.id);
    await as(orderRoute, "PUT", { id }, { status: "FULFILLED" });
    expect(await committed(w, w.shelf.id)).toEqual([]);

    // The buttons and the dispatch status can't reopen it on their own.
    const back = await as(orderRoute, "PUT", { id }, { status: "ORDER" });
    expect([back.statusCode, back.body.error]).toEqual([
      409,
      expect.stringMatching(/Undo handover/),
    ]);
    const dispatch = await as(dispatchRoute, "PUT", { id }, { dispatchStatus: "READY_FOR_PICKUP" });
    expect(dispatch.statusCode).toBe(409);
    expect((await orderNow(w)).status).toBe("FULFILLED");

    expect((await undoIt(w.order.id, "Customer left it behind")).statusCode).toBe(200);
    expect(await committed(w, w.shelf.id)).toEqual([
      [w.lamp.id, 2],
      [w.sofa.id, 1],
    ]);
    expect(await orderNow(w)).toMatchObject({ status: "ORDER", deliveredAt: null });

    // And it can be handed over, and undone, again.
    await as(orderRoute, "PUT", { id }, { status: "FULFILLED" });
    expect((await undoIt(w.order.id, "Again")).statusCode).toBe(200);
    expect(await prisma.orderHandover.count({ where: { undoneAt: { not: null } } })).toBe(2);
  });
});

describe("what refuses an undo", () => {
  it("a missing reason, an order not handed over, and a handover with no record", async () => {
    const w = await world("TAKEN");
    expect((await undoIt(w.order.id)).body.error).toMatch(/hasn't been handed over/);
    await as(orderRoute, "PUT", { id: String(w.order.id) }, { status: "FULFILLED" });
    expect((await undoIt(w.order.id, "  ")).statusCode).toBe(400);
    expect((await as(undo, "POST", { id: "99999" }, { reason: "x" })).statusCode).toBe(404);

    // A handover recorded before handovers were: nothing says what it moved.
    const old = await prisma.salesOrder.create({
      data: {
        orderno: "SO-OLD",
        status: "FULFILLED",
        deliveredAt: new Date("2026-01-01T12:00:00Z"),
        orderDate: new Date("2025-12-20T12:00:00Z"),
      },
    });
    const res = await undoIt(old.id);
    expect([res.statusCode, res.body.error]).toEqual([
      409,
      expect.stringMatching(/recorded before/),
    ]);
  });

  it("goods coming back on a return against the order", async () => {
    const w = await world("TAKEN");
    await as(orderRoute, "PUT", { id: String(w.order.id) }, { status: "FULFILLED" });
    await prisma.return.create({
      data: { returnNumber: "RET-1", reason: "DEFECTIVE", salesOrderId: w.order.id },
    });
    const res = await undoIt(w.order.id);
    expect([res.statusCode, res.body.error]).toEqual([409, expect.stringMatching(/returned/)]);
    expect(await committed(w, w.shelf.id)).toEqual([]);
  });

  it("commission on the order paid out for the period it counted in -- and not another period", async () => {
    const w = await world("TAKEN");
    await as(orderRoute, "PUT", { id: String(w.order.id) }, { status: "FULFILLED" });
    const payout = (periodStart: string, periodEnd: string, paidOn: Date | null) =>
      prisma.commissionPayout.create({
        data: {
          staffMemberId: w.designer.id,
          periodStart: new Date(periodStart),
          periodEnd: new Date(periodEnd),
          periodSalesAmount: 2400,
          ytdSalesAtStart: 0,
          ytdSalesAtEnd: 2400,
          tierBreakdown: [],
          commissionAmount: 120,
          tierDefinitionSnapshot: [],
          paidOn,
        },
      });
    // February's payout is paid; the sale counted in March (written 10 March),
    // whose payout is paid too.
    await payout("2026-02-01T00:00:00Z", "2026-02-28T00:00:00Z", new Date());
    const march = await payout("2026-03-01T00:00:00Z", "2026-03-31T00:00:00Z", new Date());
    const res = await undoIt(w.order.id);
    expect([res.statusCode, res.body.error]).toEqual([
      409,
      expect.stringMatching(/paid to Dana Reyes/),
    ]);

    // March not paid after all: February's paid payout doesn't stop it.
    await prisma.commissionPayout.update({ where: { id: march.id }, data: { paidOn: null } });
    expect((await undoIt(w.order.id)).statusCode).toBe(200);
  });

  it("is a manager's: without Undo a handover the route refuses", async () => {
    const w = await world("TAKEN");
    await as(orderRoute, "PUT", { id: String(w.order.id) }, { status: "FULFILLED" });
    await syncBuiltInRoles({ prisma });
    for (const [key, email] of [
      ["DESIGNER", "designer@example.com"],
      ["MANAGER", "manager@example.com"],
    ] as const) {
      await prisma.user.create({ data: { id: key, email } });
      const role = await prisma.role.findUniqueOrThrow({ where: { key } });
      await prisma.staffMember.create({
        data: { userId: key, email, displayName: key, role: key, roleId: role.id },
      });
    }
    const call = async (userId: string, email: string) => {
      sessionMock.mockResolvedValue({ user: { id: userId, email } });
      const res = makeRes();
      await undoRoute(req("POST", { id: String(w.order.id) }, { reason: "Wrong order" }), res);
      return res.statusCode;
    };
    expect(await call("DESIGNER", "designer@example.com")).toBe(403);
    expect(await call("MANAGER", "manager@example.com")).toBe(200);
  });
});
