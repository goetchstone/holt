// /app/__tests__/integration/scanTransfer.integration.test.ts
//
// GAP-19: transfers on the handheld against real Postgres
// (pages/api/scan/transfer/send.ts and receive.ts, sendFromPlace and
// receiveArrivals in lib/inventory/transfers.ts). Sending takes free units
// first and each order's own on a transfer of its own; receiving takes an
// order's transfer first, then the oldest, all of it or none; a resend moves
// nothing twice; and the desk's receipt and the handheld's share one claim.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession, type Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { toQty } from "@/lib/inventory/quantity";
import { landingPlaceId } from "@/lib/inventory/places";
import {
  claimAndReceive,
  TransferQuantityError,
  TransferRaceError,
} from "@/lib/inventory/transfers";
import sendRoute, { handler as sendHandler } from "@/pages/api/scan/transfer/send";
import receiveRoute, { handler as receiveHandler } from "@/pages/api/scan/transfer/receive";
import { handler as moveHandler } from "@/pages/api/scan/move";
import { handler as statusHandler } from "@/pages/api/warehouse/transfers/[id]/status";
import { handler as transfersHandler } from "@/pages/api/warehouse/transfers/index";
import { stockAt } from "../helpers/stock";

function makeRes() {
  const res = {
    statusCode: 200,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res as unknown as NextApiResponse & { statusCode: number; body: any };
}

type Handler = (req: NextApiRequest, res: NextApiResponse, session: Session) => Promise<unknown>;

async function call(
  handler: Handler,
  session: Session,
  method: string,
  body: unknown = {},
  query: Record<string, string> = {},
) {
  const res = makeRes();
  await handler({ method, query, body, headers: {} } as unknown as NextApiRequest, res, session);
  return res;
}

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id, trackInventory: true },
  });
  const product = (productNumber: string, name: string) =>
    prisma.product.create({
      data: {
        productNumber,
        name,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
  const chair = await product("CHAIR", "Chair");
  const lamp = await product("LAMP", "Lamp");
  const mill = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const harbor = await prisma.storeLocation.create({
    data: { name: "Harbor", code: "HARB", type: "STORE" },
  });
  const place = (storeLocationId: number, code: string, extra: object = {}) =>
    prisma.stockLocation.create({ data: { storeLocationId, code, name: code, ...extra } });
  const bay = await place(mill.id, "BAY");
  const floor = await place(harbor.id, "FLOOR", { locationType: "FLOOR" });
  const back = await place(harbor.id, "BACK");
  const user = await prisma.user.create({ data: { email: "wh@example.test" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  return { chair, lamp, mill, harbor, bay, floor, back, user, session };
}

type World = Awaited<ReturnType<typeof world>>;

async function orderAt(store: string, orderno: string) {
  const customer = await prisma.customer.create({ data: { firstName: "C", lastName: orderno } });
  return prisma.salesOrder.create({
    data: {
      orderno,
      status: "ORDER",
      orderDate: new Date(),
      customerId: customer.id,
      storeLocation: store,
    },
  });
}

/** What a place holds of a product, owner by owner. */
const at = async (productId: number, stockLocationId: number) =>
  (
    await prisma.inventoryPosition.findMany({
      where: { productId, stockLocationId, quantity: { gt: 0 } },
      orderBy: [{ salesOrderId: "asc" }],
    })
  ).map((p) => [p.salesOrderId, toQty(p.quantity)]);

const transitOf = async (storeLocationId: number) =>
  (await prisma.storeLocation.findUniqueOrThrow({ where: { id: storeLocationId } }))
    .transitStockLocationId!;

const send = (w: World, body: Record<string, unknown>) =>
  call(sendHandler, w.session, "POST", {
    fromStockLocationId: w.bay.id,
    toLocationId: w.harbor.id,
    ...body,
  });

const receive = (w: World, body: Record<string, unknown>) =>
  call(receiveHandler, w.session, "POST", { storeLocationId: w.harbor.id, ...body });

describe("transfers on the handheld (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("sending", () => {
    it("takes free units first, then an order's own on a transfer of its own, on its way at once", async () => {
      const w = await world();
      const order = await orderAt("Harbor", "SO-1");
      await stockAt({
        productId: w.chair.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        quantity: 2,
      });
      await stockAt({
        productId: w.chair.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        salesOrderId: order.id,
        quantity: 2,
      });

      const res = await send(w, {
        actionKey: "send-free-first",
        items: [{ productId: w.chair.id, units: 3 }],
      });
      expect(res.statusCode).toBe(201);
      expect(res.body).toMatchObject({ units: 3, committed: 1, replayed: false });

      const transfers = await prisma.inventoryTransfer.findMany({ orderBy: { id: "asc" } });
      expect(
        transfers.map((t) => [
          t.status,
          toQty(t.quantity),
          t.salesOrderId,
          t.fromStockLocationId,
          t.toLocationId,
          t.toStockLocationId,
          t.requestedByUserId,
          t.fromLocation,
          t.toLocation,
        ]),
      ).toEqual([
        ["IN_TRANSIT", 2, null, w.bay.id, w.harbor.id, null, w.user.id, "Mill", "Harbor"],
        ["IN_TRANSIT", 1, order.id, w.bay.id, w.harbor.id, null, w.user.id, "Mill", "Harbor"],
      ]);
      expect(res.body.transfers).toEqual(transfers.map((t) => t.id));
      expect(transfers.every((t) => t.shippedAt !== null)).toBe(true);

      // Owned and counted in Mill's transit place, the order's unit still its.
      expect(await at(w.chair.id, await transitOf(w.mill.id))).toEqual([
        [order.id, 1],
        [null, 2],
      ]);
      expect(await at(w.chair.id, w.bay.id)).toEqual([[order.id, 1]]);
      const keyed = await prisma.stockMovement.count({ where: { actionKey: "send-free-first" } });
      expect(keyed).toBe(2);
    });

    it("refuses more than the place holds, naming it, and sends nothing", async () => {
      const w = await world();
      await stockAt({
        productId: w.chair.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        quantity: 2,
      });
      await stockAt({
        productId: w.lamp.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        quantity: 5,
      });
      const res = await send(w, {
        actionKey: "send-too-many",
        items: [
          { productId: w.lamp.id, units: 1 },
          { productId: w.chair.id, units: 3 },
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe("Only 2 Chair at BAY.");
      expect(await prisma.inventoryTransfer.count()).toBe(0);
      expect(await at(w.lamp.id, w.bay.id)).toEqual([[null, 5]]);
    });

    it("refuses a place that holds no stock of its own, a closed store, and a place elsewhere", async () => {
      const w = await world();
      const group = await prisma.stockLocation.create({
        data: { storeLocationId: w.mill.id, code: "BARN", name: "Barn", locationType: "GROUP" },
      });
      const shut = await prisma.storeLocation.create({
        data: { name: "Old Annex", code: "OA", type: "STORE", isActive: false },
      });
      await stockAt({
        productId: w.chair.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        quantity: 2,
      });
      const items = [{ productId: w.chair.id, units: 1 }];
      let n = 0;
      const refused = async (body: Record<string, unknown>) => {
        const res = await send(w, { actionKey: `refuse-key-${n++}`, items, ...body });
        expect(res.statusCode).toBe(400);
        return res.body.error;
      };
      expect(await refused({ fromStockLocationId: group.id })).toBe(
        "Barn groups places: scan one inside it.",
      );
      const transit = await landingPlaceId(prisma, w.mill.id, "TRANSIT");
      expect(await refused({ fromStockLocationId: transit })).toMatch(/is an in-transit place/);
      expect(await refused({ toLocationId: shut.id })).toBe("Choose an open store to send it to.");
      expect(await refused({ toStockLocationId: w.bay.id })).toBe("BAY isn't at Harbor.");
      expect(await refused({ toLocationId: w.mill.id })).toBe(
        "Within one store, scan the place it is going to.",
      );
      expect(await refused({ toLocationId: w.mill.id, toStockLocationId: w.bay.id })).toBe(
        "It is already there.",
      );
      expect(await prisma.inventoryTransfer.count()).toBe(0);
      expect(await at(w.chair.id, w.bay.id)).toEqual([[null, 2]]);
    });

    it("a resend with the same key sends nothing twice", async () => {
      const w = await world();
      await stockAt({
        productId: w.chair.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        quantity: 3,
      });
      const body = { actionKey: "send-once-0001", items: [{ productId: w.chair.id, units: 1 }] };
      expect((await send(w, body)).statusCode).toBe(201);
      const again = await send(w, body);
      expect(again.statusCode).toBe(200);
      expect(again.body.replayed).toBe(true);
      expect(await prisma.inventoryTransfer.count()).toBe(1);
      expect(await at(w.chair.id, w.bay.id)).toEqual([[null, 2]]);
    });

    it("a move refused as tracked goes as a transfer to the place scanned, and arrives there", async () => {
      const w = await world();
      await stockAt({
        productId: w.chair.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        quantity: 1,
      });
      const items = [{ productId: w.chair.id, units: 1 }];
      const move = await call(moveHandler, w.session, "POST", {
        actionKey: "move-tracked-01",
        fromStockLocationId: w.bay.id,
        toStockLocationId: w.floor.id,
        items,
      });
      expect(move.statusCode).toBe(400);
      expect(move.body.tracked).toBe(true);

      const sent = await send(w, {
        actionKey: "move-as-transfer",
        toStockLocationId: w.floor.id,
        items,
      });
      expect(sent.statusCode).toBe(201);
      expect((await receive(w, { actionKey: "arrive-floor", items })).statusCode).toBe(201);
      expect(await at(w.chair.id, w.floor.id)).toEqual([[null, 1]]);
      expect(await at(w.chair.id, w.bay.id)).toEqual([]);
    });
  });

  describe("receiving", () => {
    async function onTheWay(w: World) {
      const order = await orderAt("Harbor", "SO-9");
      await stockAt({
        productId: w.chair.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        quantity: 2,
      });
      // The free units leave first, the order's next, each on its own transfer.
      expect(
        (
          await send(w, {
            actionKey: "on-the-way-free",
            items: [{ productId: w.chair.id, units: 2 }],
          })
        ).statusCode,
      ).toBe(201);
      await stockAt({
        productId: w.chair.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        salesOrderId: order.id,
        quantity: 1,
      });
      expect(
        (
          await send(w, {
            actionKey: "on-the-way-sold",
            items: [{ productId: w.chair.id, units: 1 }],
          })
        ).statusCode,
      ).toBe(201);
      const [free, sold] = await prisma.inventoryTransfer.findMany({ orderBy: { id: "asc" } });
      return { order, free, sold };
    }

    it("lists what is on its way to the store", async () => {
      const w = await world();
      const { free, sold } = await onTheWay(w);
      const res = await call(
        receiveHandler,
        w.session,
        "GET",
        {},
        {
          storeLocationId: String(w.harbor.id),
        },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.transfers).toEqual([
        {
          id: free.id,
          productId: w.chair.id,
          productNumber: "CHAIR",
          name: "Chair",
          boxesPerUnit: 1,
          from: "Mill",
          remaining: 2,
          toPlace: null,
          orderNo: null,
        },
        expect.objectContaining({ id: sold.id, remaining: 1, orderNo: "SO-9" }),
      ]);
      const elsewhere = await call(
        receiveHandler,
        w.session,
        "GET",
        {},
        {
          storeLocationId: String(w.mill.id),
        },
      );
      expect(elsewhere.body.transfers).toEqual([]);
    });

    it("takes an order's transfer first, then the oldest, into the place scanned; the rest stays on its way", async () => {
      const w = await world();
      const { order, free, sold } = await onTheWay(w);
      const res = await receive(w, {
        actionKey: "arrive-two",
        toStockLocationId: w.back.id,
        items: [{ productId: w.chair.id, units: 2 }],
      });
      expect(res.statusCode).toBe(201);
      expect(res.body).toMatchObject({ units: 2, transfers: 2, completed: 1 });

      const after = async (id: number) =>
        prisma.inventoryTransfer.findUniqueOrThrow({ where: { id } });
      expect(await after(sold.id)).toMatchObject({ status: "RECEIVED" });
      const part = await after(free.id);
      expect([part.status, toQty(part.receivedQuantity)]).toEqual(["IN_TRANSIT", 1]);
      expect(await at(w.chair.id, w.back.id)).toEqual([
        [order.id, 1],
        [null, 1],
      ]);
      expect(await at(w.chair.id, await transitOf(w.mill.id))).toEqual([[null, 1]]);
      expect(await prisma.stockMovement.count({ where: { actionKey: "arrive-two" } })).toBe(2);
    });

    it("refuses more than is on its way, naming it, and receives none of what was scanned", async () => {
      const w = await world();
      await onTheWay(w);
      await stockAt({
        productId: w.lamp.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        quantity: 1,
      });
      await send(w, { actionKey: "lamp-on-the-way", items: [{ productId: w.lamp.id, units: 1 }] });
      const res = await receive(w, {
        actionKey: "arrive-too-many",
        items: [
          { productId: w.chair.id, units: 4 },
          { productId: w.lamp.id, units: 1 },
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe("Only 3 Chair on the way to Harbor; 4 scanned.");
      expect(await prisma.inventoryTransfer.count({ where: { status: "RECEIVED" } })).toBe(0);
      const received = await prisma.inventoryTransfer.aggregate({
        _sum: { receivedQuantity: true },
      });
      expect(toQty(received._sum.receivedQuantity)).toBe(0);
    });

    it("refuses what isn't on its way, and a place at another store", async () => {
      const w = await world();
      await onTheWay(w);
      const lamp = await receive(w, {
        actionKey: "arrive-a-lamp",
        items: [{ productId: w.lamp.id, units: 1 }],
      });
      expect(lamp.statusCode).toBe(400);
      expect(lamp.body.error).toBe("Lamp isn't on its way to Harbor.");
      // A lamp on its way to another store is not one arriving here.
      const quay = await prisma.storeLocation.create({
        data: { name: "Quay", code: "QUAY", type: "STORE" },
      });
      await stockAt({
        productId: w.lamp.id,
        storeLocationId: w.mill.id,
        stockLocationId: w.bay.id,
        quantity: 1,
      });
      await send(w, {
        actionKey: "lamp-to-quay",
        toLocationId: quay.id,
        items: [{ productId: w.lamp.id, units: 1 }],
      });
      const notHere = await receive(w, {
        actionKey: "arrive-quay-lamp",
        items: [{ productId: w.lamp.id, units: 1 }],
      });
      expect(notHere.statusCode).toBe(400);
      expect(notHere.body.error).toBe("Lamp isn't on its way to Harbor.");
      expect(await prisma.inventoryTransfer.count({ where: { status: "RECEIVED" } })).toBe(0);
      const wrongPlace = await receive(w, {
        actionKey: "arrive-elsewhere",
        toStockLocationId: w.bay.id,
        items: [{ productId: w.chair.id, units: 1 }],
      });
      expect(wrongPlace.statusCode).toBe(400);
      expect(wrongPlace.body.error).toBe("BAY isn't at Harbor.");
    });

    it("a resend with the same key receives nothing twice", async () => {
      const w = await world();
      const { free } = await onTheWay(w);
      const body = { actionKey: "arrive-once-01", items: [{ productId: w.chair.id, units: 1 }] };
      expect((await receive(w, body)).statusCode).toBe(201);
      const again = await receive(w, body);
      expect(again.statusCode).toBe(200);
      expect(again.body.replayed).toBe(true);
      const total = await prisma.inventoryTransfer.aggregate({ _sum: { receivedQuantity: true } });
      expect(toQty(total._sum.receivedQuantity)).toBe(1);
      expect(
        toQty(
          (await prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: free.id } }))
            .receivedQuantity,
        ),
      ).toBe(0);
    });

    it("shares one claim with the desk: a receipt from a stale read moves nothing", async () => {
      const w = await world();
      const { free } = await onTheWay(w);
      const stale = await prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: free.id } });
      const desk = await call(
        statusHandler,
        w.session,
        "PUT",
        { status: "RECEIVED", quantity: 1 },
        {
          id: String(free.id),
        },
      );
      expect(desk.statusCode).toBe(200);

      await expect(
        prisma.$transaction((tx) => claimAndReceive(tx, stale, 1, "late@example.test")),
      ).rejects.toBeInstanceOf(TransferRaceError);
      const now = await prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: free.id } });
      expect(toQty(now.receivedQuantity)).toBe(1);
      expect(
        await prisma.inventoryPosition.count({
          where: { productId: w.chair.id, storeLocationId: w.harbor.id, quantity: { gt: 0 } },
        }),
      ).toBe(1);
    });
  });

  it("is on Move stock, the desk's transfer key: the warehouse sends and receives, a designer can't", async () => {
    const w = await world();
    invalidateRoleGrantCache();
    await syncBuiltInRoles({ prisma });
    const staff = async (id: string, roleKey: string) => {
      await prisma.user.create({ data: { id, email: `${id}@example.com` } });
      const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
      await prisma.staffMember.create({
        data: {
          userId: id,
          displayName: id,
          email: `${id}@example.com`,
          role: roleKey as never,
          roleId: role.id,
          isActive: true,
        },
      });
    };
    // An admin on file, so the bootstrap safeguard is off and a refusal is real.
    await staff("ada", "ADMIN");
    await staff("wes", "WAREHOUSE");
    await staff("dee", "DESIGNER");
    await stockAt({
      productId: w.chair.id,
      storeLocationId: w.mill.id,
      stockLocationId: w.bay.id,
      quantity: 1,
    });
    const gated = async (route: typeof sendRoute, userId: string, method: string, body = {}) => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: userId, email: `${userId}@example.com` },
      });
      const res = makeRes();
      await route(
        { method, query: { storeLocationId: String(w.harbor.id) }, body, cookies: {} } as never,
        res,
      );
      return res.statusCode;
    };
    const body = {
      actionKey: "gate-send-0001",
      fromStockLocationId: w.bay.id,
      toLocationId: w.harbor.id,
      items: [{ productId: w.chair.id, units: 1 }],
    };
    expect(await gated(sendRoute, "dee", "POST", body)).toBe(403);
    expect(await gated(receiveRoute, "dee", "GET")).toBe(403);
    expect(await prisma.inventoryTransfer.count()).toBe(0);
    expect(await gated(sendRoute, "wes", "POST", body)).toBe(201);
    expect(await gated(receiveRoute, "wes", "GET")).toBe(200);
  });

  it("the shared claim receives only a transfer on its way: a draft moves nothing", async () => {
    const w = await world();
    await stockAt({
      productId: w.chair.id,
      storeLocationId: w.mill.id,
      stockLocationId: w.bay.id,
      quantity: 1,
    });
    const created = await call(transfersHandler, w.session, "POST", {
      productId: w.chair.id,
      fromLocationId: w.mill.id,
      toLocationId: w.harbor.id,
      quantity: 1,
    });
    expect(created.statusCode).toBe(201);
    const draft = await prisma.inventoryTransfer.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    await expect(
      prisma.$transaction((tx) => claimAndReceive(tx, draft, null, "wh@example.test")),
    ).rejects.toBeInstanceOf(TransferQuantityError);
    expect(
      await prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: draft.id } }),
    ).toMatchObject({
      status: "DRAFT",
    });
    expect(
      await prisma.inventoryPosition.count({
        where: { storeLocationId: w.harbor.id, quantity: { gt: 0 } },
      }),
    ).toBe(0);
  });
});
