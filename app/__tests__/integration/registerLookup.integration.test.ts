// /app/__tests__/integration/registerLookup.integration.test.ts
//
// What the register reads to choose where a payment is taken and to look a
// sale up, against the real database and through the real gates:
//
//   - the register list says which registers have a till open and which have a
//     card reader, so the payment screen's "Change register" can say so;
//   - the orders list says what each sale still owes, the way every balance
//     says it, so the lookup offers "Take payment" on the ones that do.
//
// Only the session readers are mocked.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import registersRoute from "@/pages/api/registers/index";
import ordersRoute from "@/pages/api/sales/orders/index";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

/** GET a route through its real gate, signed in as `who`. */
async function get(route: Route, who: string, query: Record<string, string> = {}) {
  const session = { user: { id: who, email: `${who}@example.com` } };
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  await route(
    { method: "GET", query, body: {}, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return { status, body: body as Body };
}

async function makeStaff(who: string, roleKey: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: { userId: who, displayName: who, role: roleKey as never, roleId: role.id },
  });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the register list, for choosing where to take a payment", () => {
  it("says which registers have a till open and which have a card reader", async () => {
    const cashier = await makeStaff("cass", "REGISTER");
    const store = await prisma.storeLocation.create({
      data: { name: "Harbor Showroom", code: "HS1", type: "STORE" },
    });
    const make = (name: string) =>
      prisma.register.create({ data: { name, storeLocationId: store.id } });
    const [plain, withTill, withBoth, closedTill, readerOff] = await Promise.all(
      ["Register 1", "Register 2", "Register 3", "Register 4", "Register 5"].map(make),
    );
    const till = (registerId: number, status: "OPEN" | "CLOSED") =>
      prisma.till.create({
        data: { registerId, status, openedById: cashier.id, openingCash: 200 },
      });
    await till(withTill.id, "OPEN");
    await till(withBoth.id, "OPEN");
    await till(closedTill.id, "CLOSED");
    const reader = (registerId: number, isActive: boolean) =>
      prisma.cardReader.create({
        data: {
          label: `Reader ${registerId}`,
          registerId,
          isActive,
          processorType: "STRIPE",
          processorReaderId: `tmr_${registerId}`,
          deviceType: "simulated_wisepos_e",
        },
      });
    await reader(withBoth.id, true);
    await reader(readerOff.id, false);

    const res = await get(registersRoute, "cass", { limit: "50" });

    expect(res.status).toBe(200);
    const has = Object.fromEntries(
      (res.body.registers as Body[]).map((r) => [r.id, [r.hasOpenTill, r.hasCardReader]]),
    );
    expect(has).toEqual({
      [plain.id]: [false, false],
      [withTill.id]: [true, false],
      [withBoth.id]: [true, true],
      // A closed till is not one to book against, and a reader switched off is not one to send to.
      [closedTill.id]: [false, false],
      [readerOff.id]: [false, false],
    });
    // The rows those were read from are not sent.
    expect(res.body.registers[0]).not.toHaveProperty("tills");
    expect(res.body.registers[0]).not.toHaveProperty("cardReader");
  });
});

describe("the orders list, for looking a sale up from the register", () => {
  const day = new Date("2026-11-01T15:00:00Z");
  const sale = (orderno: string, customerId: number, paid: number[], status = "ORDER") =>
    prisma.salesOrder.create({
      data: {
        orderno,
        status: status as never,
        orderDate: day,
        customerId,
        lineItems: {
          create: [
            { lineNumber: 1, netPrice: 1000, vatAmount: 60, cost: 400, orderedQuantity: 1 },
            // Cancelled: not owed.
            {
              lineNumber: 2,
              netPrice: 500,
              vatAmount: 30,
              cost: 200,
              orderedQuantity: 1,
              lineItemStatus: "CANCELLED",
            },
          ],
        },
        payments: {
          create: paid.map((paymentAmount) => ({
            paymentDate: day,
            paymentType: "Card",
            paymentAmount,
            status: "COMPLETED" as const,
          })),
        },
      },
    });

  it("finds a sale by its number or its customer, and says what it still owes", async () => {
    await makeStaff("cass", "REGISTER");
    const ana = await prisma.customer.create({ data: { firstName: "Ana", lastName: "Reyes" } });
    const bo = await prisma.customer.create({ data: { firstName: "Bo", lastName: "Lindqvist" } });
    await sale("SO-2001", ana.id, [530]);
    await sale("SO-2002", ana.id, [1060]);
    await sale("SO-2003", bo.id, []);
    // Up to a dollar owed reads as paid, as on every other screen.
    await sale("SO-2004", bo.id, [1059.5]);

    const byName = await get(ordersRoute, "cass", { search: "reyes", limit: "8" });
    expect(byName.status).toBe(200);
    const owed = (body: Body) =>
      Object.fromEntries((body.orders as Body[]).map((o) => [o.orderno, o.balanceDue]));
    expect(owed(byName.body)).toEqual({ "SO-2001": 530, "SO-2002": 0 });

    const byNumber = await get(ordersRoute, "cass", { search: "SO-2003", limit: "8" });
    expect(owed(byNumber.body)).toEqual({ "SO-2003": 1060 });

    const nearly = await get(ordersRoute, "cass", { search: "SO-2004", limit: "8" });
    expect(owed(nearly.body)).toEqual({ "SO-2004": 0 });
  });

  it("is not answered for someone who may operate the register and not view orders", async () => {
    // The lookup reads this list, so its gate is the list's own ("View orders").
    // An owner exists: with nobody privileged the gates let a first user in.
    await makeStaff("owner", "SUPER_ADMIN");
    await prisma.user.create({ data: { id: "ringer", email: "ringer@example.com" } });
    const role = await prisma.role.create({
      data: {
        key: "CUSTOM_RINGER",
        name: "Ringer",
        isSystem: false,
        permissions: { create: [{ permission: "pos.operate" }] },
      },
    });
    invalidateRoleGrantCache();
    await prisma.staffMember.create({
      data: { userId: "ringer", displayName: "ringer", role: "DESIGNER", roleId: role.id },
    });

    const res = await get(ordersRoute, "ringer", { search: "SO", limit: "8" });

    expect(res.status).toBe(403);
    // And the register list, which that role does hold, still answers.
    expect((await get(registersRoute, "ringer")).status).toBe(200);
  });
});
