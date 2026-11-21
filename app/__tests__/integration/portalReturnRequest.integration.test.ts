// /app/__tests__/integration/portalReturnRequest.integration.test.ts
//
// The customer's return request (POST /api/portal/returns/request) is public:
// whoever holds the Return's portalToken can call it. Three holes, closed here
// against Postgres:
//
//   - lineItemId was written as sent, so a token holder could point their
//     return at a line on ANYONE's order -- and a return is valued from its
//     line when staff pay it out (lib/returns/bookReturn.ts). A line must now be
//     on the return's own order, still counted (not cancelled or replaced, with
//     a quantity above zero: rules 31 and 33) and goods (not a gift card or the
//     delivery fee). The staff return-link endpoint takes the same rule, from
//     the same function (lib/returns/returnLine.ts).
//   - an unknown reason reached the ReturnReason enum column: a 500. Now a 400.
//   - the route answered with the whole Return row. Now with the fields the
//     portal pages read, and nothing else.
//
// Real routes, real database; next-auth's session is the only mock (for the
// staff route).

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import requestRoute from "@/pages/api/portal/returns/request";
import statusRoute from "@/pages/api/portal/returns/[token]";
import returnLinkRoute from "@/pages/api/sales/orders/[id]/return-link";

const NOT_ON_ORDER = "That line isn't on the order this return is for.";
const NOT_RETURNABLE =
  "That line can't be returned: it was cancelled or replaced, or it is a gift card or the order's delivery fee.";
const PORTAL_FIELDS = [
  "created",
  "customerNotes",
  "productName",
  "quantity",
  "returnNumber",
  "status",
];

let ip = 0;
/** A fresh client address per request, so the routes' rate limits never decide a case. */
const socket = () => ({ remoteAddress: `10.1.${Math.floor(++ip / 250)}.${ip % 250}` });

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  req: object,
): Promise<{ status: number; body: any }> {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  await route({ headers: {}, cookies: {}, socket: socket(), ...req } as NextApiRequest, res);
  return { status, body: JSON.parse(JSON.stringify(body ?? null)) };
}

const submit = (body: object) => call(requestRoute, { method: "POST", query: {}, body });

async function world() {
  const customer = await prisma.customer.create({ data: { firstName: "Ada", lastName: "Lane" } });
  const stranger = await prisma.customer.create({ data: { firstName: "Bo", lastName: "Hart" } });
  const line = (productName: string, extra: object = {}) => ({
    productName,
    orderedQuantity: 1,
    netPrice: 1000,
    cost: 400,
    ...extra,
  });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-200",
      status: "ORDER",
      orderDate: new Date(),
      customerId: customer.id,
      lineItems: {
        create: [
          line("Camelback Sofa", { lineNumber: 1 }),
          line("Side Chair", { lineNumber: 2, lineItemStatus: "CANCELLED" }),
          line("Old Lamp", { lineNumber: 3, lineItemStatus: "REPLACED" }),
          line("Ottoman", { lineNumber: 4, orderedQuantity: 0 }),
          line("Gift card", { lineNumber: 5, netPrice: 100, cost: 0, giftCardNumber: "GC-200" }),
          line("Delivery", { lineNumber: 6, netPrice: 150, cost: 0 }),
          line("Throw Pillow", { lineNumber: 7, lineItemStatus: "BACKORDERED" }),
        ],
      },
    },
    include: { lineItems: { orderBy: { lineNumber: "asc" } } },
  });
  const [sofa, cancelled, replaced, zero, card, fee, backordered] = order.lineItems;
  await prisma.salesOrder.update({
    where: { id: order.id },
    data: { deliveryFeeLineItemId: fee.id },
  });
  const other = await prisma.salesOrder.create({
    data: {
      orderno: "SO-201",
      status: "ORDER",
      orderDate: new Date(),
      customerId: stranger.id,
      lineItems: { create: [line("Grand Piano", { netPrice: 9000 })] },
    },
    include: { lineItems: true },
  });
  const portalToken = randomUUID();
  const ret = await prisma.return.create({
    data: {
      returnNumber: "RET-TEST-001",
      status: "INITIATED",
      reason: "OTHER",
      salesOrderId: order.id,
      customerId: customer.id,
      portalToken,
      portalRequestedAt: new Date(),
    },
  });
  return {
    order,
    ret,
    portalToken,
    lines: { sofa, cancelled, replaced, zero, card, fee, backordered },
    foreign: other.lineItems[0],
  };
}

type World = Awaited<ReturnType<typeof world>>;
let w: World;

const unchanged = async () =>
  prisma.return.findUniqueOrThrow({
    where: { id: w.ret.id },
    select: { lineItemId: true, reason: true, customerNotes: true },
  });

// File level, so it runs after both describes rather than between them.
afterAll(async () => {
  await prisma.$disconnect();
});

describe("the customer's return request", () => {
  beforeEach(async () => {
    await resetTestDb();
    w = await world();
  });

  it("refuses a line from another order, and writes nothing", async () => {
    const got = await submit({
      portalToken: w.portalToken,
      reason: "DEFECTIVE",
      lineItemId: w.foreign.id,
    });
    expect(got).toEqual({ status: 400, body: { error: NOT_ON_ORDER } });
    expect(await unchanged()).toEqual({ lineItemId: null, reason: "OTHER", customerNotes: null });
  });

  it("refuses a line that does not exist the same way", async () => {
    const got = await submit({
      portalToken: w.portalToken,
      reason: "DEFECTIVE",
      lineItemId: 999999,
    });
    expect(got).toEqual({ status: 400, body: { error: NOT_ON_ORDER } });
  });

  it.each([["cancelled"], ["replaced"], ["zero"], ["card"], ["fee"]])(
    "refuses the order's %s line, and writes nothing",
    async (key) => {
      const lineItemId = w.lines[key as keyof World["lines"]].id;
      const got = await submit({ portalToken: w.portalToken, reason: "DEFECTIVE", lineItemId });
      expect(got).toEqual({ status: 400, body: { error: NOT_RETURNABLE } });
      expect(await unchanged()).toEqual({ lineItemId: null, reason: "OTHER", customerNotes: null });
    },
  );

  it("takes a counted line on the return's own order", async () => {
    for (const key of ["sofa", "backordered"] as const) {
      const lineItemId = w.lines[key].id;
      const got = await submit({
        portalToken: w.portalToken,
        reason: "DEFECTIVE",
        reasonNotes: "Torn seam",
        lineItemId,
      });
      expect(got.status).toBe(200);
      expect(await unchanged()).toEqual({
        lineItemId,
        reason: "DEFECTIVE",
        customerNotes: "Torn seam",
      });
    }
  });

  it("answers an unknown reason with a 400 that names the reasons, not a 500", async () => {
    const got = await submit({ portalToken: w.portalToken, reason: "BROKEN" });
    expect(got.status).toBe(400);
    expect(got.body.error).toMatch(/^reason must be one of DEFECTIVE, /);
    expect(await unchanged()).toEqual({ lineItemId: null, reason: "OTHER", customerNotes: null });
  });

  it("answers with only what the portal pages read: the status route's projection", async () => {
    const got = await submit({
      portalToken: w.portalToken,
      reason: "WRONG_ITEM",
      reasonNotes: "Wrong colour",
    });
    expect(got.status).toBe(200);
    expect(Object.keys(got.body).sort()).toEqual(PORTAL_FIELDS);
    expect(got.body).toMatchObject({
      returnNumber: "RET-TEST-001",
      status: "INITIATED",
      customerNotes: "Wrong colour",
      quantity: 1,
    });
    // The reason is stored, though no page reads it back.
    expect(await unchanged()).toEqual({
      lineItemId: null,
      reason: "WRONG_ITEM",
      customerNotes: "Wrong colour",
    });

    const status = await call(statusRoute, { method: "GET", query: { token: w.portalToken } });
    expect(status.status).toBe(200);
    expect(status.body).toEqual(got.body);
  });

  it("keeps the token, state and activation refusals", async () => {
    expect((await submit({ portalToken: randomUUID(), reason: "OTHER" })).status).toBe(404);

    await prisma.return.update({ where: { id: w.ret.id }, data: { portalRequestedAt: null } });
    expect((await submit({ portalToken: w.portalToken, reason: "OTHER" })).status).toBe(409);

    await prisma.return.update({
      where: { id: w.ret.id },
      data: { portalRequestedAt: new Date(), status: "RECEIVED" },
    });
    expect((await submit({ portalToken: w.portalToken, reason: "OTHER" })).status).toBe(409);
  });
});

describe("the staff return link takes the same line rule", () => {
  const sessionMock = getServerSession as jest.Mock;

  const mint = (orderId: number, body: object) =>
    call(returnLinkRoute, { method: "POST", query: { id: String(orderId) }, body });

  beforeEach(async () => {
    await resetTestDb();
    invalidateRoleGrantCache();
    await syncBuiltInRoles({ prisma });
    await prisma.user.create({ data: { id: "mia", email: "mia@example.com" } });
    const manager = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });
    await prisma.staffMember.create({
      data: {
        userId: "mia",
        displayName: "Mia",
        email: "mia@example.com",
        role: "MANAGER",
        roleId: manager.id,
        isActive: true,
      },
    });
    sessionMock.mockResolvedValue({ user: { id: "mia", email: "mia@example.com", name: "Mia" } });
    w = await world();
  });

  it("refuses a line from another order, and mints nothing", async () => {
    const got = await mint(w.order.id, { lineItemId: w.foreign.id });
    expect(got).toEqual({ status: 400, body: { error: NOT_ON_ORDER } });
    expect(await prisma.return.count()).toBe(1);
  });

  it("refuses a cancelled line, and mints nothing", async () => {
    const got = await mint(w.order.id, { lineItemId: w.lines.cancelled.id });
    expect(got).toEqual({ status: 400, body: { error: NOT_RETURNABLE } });
    expect(await prisma.return.count()).toBe(1);
  });

  it("refuses a line id that is not a whole number", async () => {
    const got = await mint(w.order.id, { lineItemId: "7" });
    expect(got.status).toBe(400);
    expect(await prisma.return.count()).toBe(1);
  });

  it("mints a link for a counted line, and for no line at all", async () => {
    const forLine = await mint(w.order.id, { lineItemId: w.lines.sofa.id });
    expect(forLine.status).toBe(200);
    const minted = await prisma.return.findUniqueOrThrow({
      where: { portalToken: forLine.body.portalToken },
      select: { lineItemId: true, salesOrderId: true },
    });
    expect(minted).toEqual({ lineItemId: w.lines.sofa.id, salesOrderId: w.order.id });

    const noLine = await mint(w.order.id, {});
    expect(noLine.status).toBe(200);
    const bare = await prisma.return.findUniqueOrThrow({
      where: { portalToken: noLine.body.portalToken },
      select: { lineItemId: true },
    });
    expect(bare.lineItemId).toBeNull();
  });
});
