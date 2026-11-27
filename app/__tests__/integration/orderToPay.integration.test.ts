// /app/__tests__/integration/orderToPay.integration.test.ts
//
// An order as the register needs it to take a payment on it
// (lib/sales/orderToPay.ts), against the real database.
//
// The register could only take a payment on the order it had just created. An
// order written earlier is now sent to it from the order page, and what the
// payment screen opens with comes from here: what the order comes to, what has
// been paid, who it is for, and whether it can take a payment at all.
//
// The two pages are rendered too (their default exports), since what they hand
// the screen is the behaviour: the register's page the order, the order's page
// whether to offer the button. Only the session readers are mocked.

jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
  useRouter: jest.fn(),
}));

import type { Prisma } from "@prisma/client";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { loadOrderToPay, orderToPayFromQuery } from "@/lib/sales/orderToPay";
import PosPage from "@/app/(dashboard)/app/sales/pos/page";
import OrderDetailPage from "@/app/(dashboard)/app/sales/orders/[id]/page";

type Line = Prisma.OrderLineItemUncheckedCreateWithoutSalesOrderInput;
type Paid = Pick<
  Prisma.PaymentUncheckedCreateWithoutSalesOrderInput,
  "paymentAmount" | "status"
> & {
  isRefund?: boolean;
};

/** A line worth `netPrice` with `vatAmount` tax on it. */
const line = (lineNumber: number, netPrice: number, vatAmount: number, more: Partial<Line> = {}) =>
  ({
    lineNumber,
    partNo: `ITEM-${lineNumber}`,
    netPrice,
    vatAmount,
    cost: 0,
    orderedQuantity: 1,
    ...more,
  }) satisfies Line;

/** An order of $1,000 and $60 tax, with the lines and payments given on top. */
async function order(
  extra: {
    status?: "QUOTE" | "ORDER" | "FULFILLED" | "CANCELLED";
    customerId?: number;
    lines?: Line[];
    payments?: Paid[];
  } = {},
) {
  const created = new Date("2026-11-01T15:00:00Z");
  return prisma.salesOrder.create({
    data: {
      orderno: `PAY-${Math.random().toString(36).slice(2, 8)}`,
      status: extra.status ?? "ORDER",
      orderDate: created,
      customerId: extra.customerId,
      lineItems: { create: [line(1, 1000, 60), ...(extra.lines ?? [])] },
      payments: {
        create: (extra.payments ?? []).map((p) => ({
          paymentDate: created,
          paymentType: "Card",
          ...p,
        })),
      },
    },
  });
}

// Once, after every describe in the file: a disconnect inside the first one is
// undone by the next describe's first query.
afterAll(async () => {
  await prisma.$disconnect();
});

describe("an order opened at the register to take a payment (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("says what it comes to, what is paid and who it is for", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Ana", lastName: "Reyes", email: "ana@example.com" },
    });
    const sale = await order({
      customerId: customer.id,
      // Cancelled: no longer owed.
      lines: [line(2, 400, 24, { lineItemStatus: "CANCELLED" })],
      payments: [
        { paymentAmount: 300, status: "COMPLETED" },
        // A payment link nobody has paid is not money in hand.
        { paymentAmount: 760, status: "PENDING" },
        { paymentAmount: 50, status: "COMPLETED", isRefund: true },
      ],
    });

    expect(await loadOrderToPay(sale.id)).toEqual({
      order: {
        id: sale.id,
        orderno: sale.orderno,
        total: 1060,
        paid: 250,
        customer: {
          id: customer.id,
          firstName: "Ana",
          lastName: "Reyes",
          email: "ana@example.com",
          phone: null,
        },
        holdsGiftCard: false,
      },
    });
  });

  it("takes a quote and an order with no customer", async () => {
    const quote = await order({ status: "QUOTE" });

    expect(await loadOrderToPay(quote.id)).toMatchObject({
      order: { total: 1060, paid: 0, customer: null },
    });
  });

  it("gives a customer with no name empty names, not nulls", async () => {
    const customer = await prisma.customer.create({ data: { email: "walkin@example.com" } });
    const sale = await order({ customerId: customer.id });

    expect(await loadOrderToPay(sale.id)).toMatchObject({
      order: { customer: { firstName: "", lastName: "" } },
    });
  });

  it("says when the order still has a gift card on it, and not for a cancelled card line", async () => {
    const withCard = await order({ lines: [line(2, 100, 0, { giftCardNumber: "GC-1001" })] });
    const cardCancelled = await order({
      lines: [line(2, 100, 0, { giftCardNumber: "GC-1002", lineItemStatus: "CANCELLED" })],
    });

    expect(await loadOrderToPay(withCard.id)).toMatchObject({
      order: { total: 1160, holdsGiftCard: true },
    });
    expect(await loadOrderToPay(cardCancelled.id)).toMatchObject({
      order: { total: 1060, holdsGiftCard: false },
    });
  });

  it("refuses an order that is not there, is cancelled, or has nothing left to pay", async () => {
    const cancelled = await order({ status: "CANCELLED" });
    const paid = await order({ payments: [{ paymentAmount: 1060, status: "COMPLETED" }] });
    // Up to a dollar still owed reads as paid everywhere a balance is shown.
    const nearly = await order({ payments: [{ paymentAmount: 1059.5, status: "COMPLETED" }] });

    expect(await loadOrderToPay(999_999)).toEqual({ problem: "That order was not found." });
    expect(await loadOrderToPay(cancelled.id)).toEqual({
      problem: `Order ${cancelled.orderno} is cancelled, so it can't take a payment.`,
    });
    expect(await loadOrderToPay(paid.id)).toEqual({
      problem: `Order ${paid.orderno} has nothing left to pay.`,
    });
    expect(await loadOrderToPay(nearly.id)).toEqual({
      problem: `Order ${nearly.orderno} has nothing left to pay.`,
    });
  });
});

describe("the order named on the register's address", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("is nothing when the register is opened the ordinary way", async () => {
    expect(await orderToPayFromQuery(undefined, true)).toBeNull();
    expect(await orderToPayFromQuery(undefined, false)).toBeNull();
  });

  it("is loaded for someone who may take payments", async () => {
    const sale = await order();

    expect(await orderToPayFromQuery(String(sale.id), true)).toMatchObject({
      order: { id: sale.id, total: 1060 },
    });
  });

  it("is refused for someone who may not, without saying whether it exists", async () => {
    const sale = await order();
    const refused = { problem: "Your role can't take payments." };

    expect(await orderToPayFromQuery(String(sale.id), false)).toEqual(refused);
    expect(await orderToPayFromQuery("999999", false)).toEqual(refused);
  });

  it("is not found when the address does not name one order by its number", async () => {
    const sale = await order();
    const notFound = { problem: "That order was not found." };

    for (const value of ["", "abc", "-1", "1.5", `${sale.id} OR 1=1`, "12345678901"]) {
      expect(await orderToPayFromQuery(value, true)).toEqual(notFound);
    }
    expect(await orderToPayFromQuery([String(sale.id), "2"], true)).toEqual(notFound);
  });
});

describe("the pages", () => {
  function signIn(who: string) {
    (getToken as jest.Mock).mockResolvedValue({ id: who });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  }

  async function settings(features: Record<string, boolean> = {}) {
    await prisma.organization.create({
      data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
    });
    await prisma.appSettings.create({ data: { organizationId: DEFAULT_ORG_ID, features } });
    invalidateAppSettingsCache();
  }

  /** Staff on a built-in role, or on a role of the store's own with just these permissions. */
  async function makeStaff(who: string, role: string | string[]) {
    await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
    const row =
      typeof role === "string"
        ? await prisma.role.findUniqueOrThrow({ where: { key: role } })
        : await prisma.role.create({
            data: {
              key: `CUSTOM_${who.toUpperCase()}`,
              name: who,
              isSystem: false,
              permissions: { create: role.map((permission) => ({ permission })) },
            },
          });
    invalidateRoleGrantCache();
    await prisma.staffMember.create({
      data: {
        userId: who,
        displayName: who,
        role: (typeof role === "string" ? role : "DESIGNER") as never,
        roleId: row.id,
      },
    });
  }

  beforeEach(async () => {
    await resetTestDb();
    invalidateRoleGrantCache();
    invalidateAppSettingsCache();
    await syncBuiltInRoles({ prisma });
  });

  const register = async (query: { order?: string }) =>
    (await PosPage({ searchParams: Promise.resolve(query) })).props.payOrder;
  const offered = async (id: number) =>
    (await OrderDetailPage({ params: Promise.resolve({ id: String(id) }) })).props
      .canTakeAtRegister;

  it("the register's page hands the screen the order named on its address", async () => {
    await settings();
    await makeStaff("cass", "REGISTER");
    signIn("cass");
    const sale = await order({ payments: [{ paymentAmount: 500, status: "COMPLETED" }] });

    expect(await register({ order: String(sale.id) })).toMatchObject({
      order: { id: sale.id, orderno: sale.orderno, total: 1060, paid: 500 },
    });
    expect(await register({})).toBeNull();
    expect(await register({ order: "nope" })).toEqual({ problem: "That order was not found." });
  });

  it("the register's page loads no order for someone who may not take payments", async () => {
    await settings();
    await makeStaff("ringer", ["pos.operate", "sales.write"]);
    signIn("ringer");
    const sale = await order();

    expect(await register({ order: String(sale.id) })).toEqual({
      problem: "Your role can't take payments.",
    });
  });

  it("the order page offers the register to someone who may take payments and operate it", async () => {
    await settings();
    const sale = await order();
    await makeStaff("mia", "MANAGER");
    await makeStaff("lin", ["sales.read", "payment.take"]);
    await makeStaff("ringer", ["sales.read", "pos.operate"]);

    signIn("mia");
    expect(await offered(sale.id)).toBe(true);
    // A payment link, yes; the register's page would turn them away.
    signIn("lin");
    expect(await offered(sale.id)).toBe(false);
    signIn("ringer");
    expect(await offered(sale.id)).toBe(false);
  });

  it("the order page does not offer the register where the store has switched it off", async () => {
    await settings({ pos: false });
    const sale = await order();
    await makeStaff("mia", "MANAGER");
    signIn("mia");

    expect(await offered(sale.id)).toBe(false);
  });
});
