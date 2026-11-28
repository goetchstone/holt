// /app/__tests__/integration/orderSeller.integration.test.ts
//
// Who sold an order is two columns: the staff member (`salesPersonId`) and
// their name (`salesperson`). Four routes that write an order knew the staff
// member and wrote only one of the two: the register, Duplicate order and a
// house call wrote the name and no link, and a converted proposal the link
// and no name (lib/sales/orderSeller.ts). Each is driven here against the real
// database, and must write both.
//
// Only the session readers are mocked; the gates are the real ones.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as duplicateHandler } from "@/pages/api/sales/orders/[id]/duplicate";
import houseCallsRoute from "@/pages/api/service/house-calls/index";
import convertRoute from "@/pages/api/proposals/[id]/convert-to-order";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

const sessionOf = (who: string) =>
  ({ user: { id: who, email: `${who}@example.com` } }) as unknown as Session;

/** A handler called directly, as `who`. */
async function call(
  handler: AnyHandler,
  who: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
) {
  const res = makeRes();
  const req = { method: "POST", query: opts.query ?? {}, body: opts.body ?? {}, headers: {} };
  await handler(
    req as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
    sessionOf(who),
  );
  return { status: res.statusCode, body: res.body as Body };
}

/** A route through its real gate, signed in as `who`. */
async function through(
  route: AnyHandler,
  who: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
) {
  (getServerSession as jest.Mock).mockResolvedValue(sessionOf(who));
  (getServerSessionNext as jest.Mock).mockResolvedValue(sessionOf(who));
  const res = makeRes();
  const req = {
    method: "POST",
    query: opts.query ?? {},
    body: opts.body ?? {},
    cookies: {},
    headers: {},
  };
  await route(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return { status: res.statusCode, body: res.body as Body };
}

async function makeStaff(who: string, displayName: string, roleKey: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId: who,
      email: `${who}@example.com`,
      displayName,
      role: roleKey as never,
      roleId: role.id,
    },
  });
}

async function sofa() {
  const vendor = await prisma.vendor.create({
    data: { name: "Harbor Works", pricingModel: "FLAT" },
  });
  const department = await prisma.department.create({ data: { name: "Living" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  return prisma.product.create({
    data: {
      productNumber: "SOFA-1",
      name: "Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseRetail: 1000,
    },
  });
}

const sellerOf = (orderId: number) =>
  prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { salesPersonId: true, salesperson: true },
  });

let store: { id: number; name: string };

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: {
      organizationId: DEFAULT_ORG_ID,
      orderNumberPrefix: "TST",
      timezone: "America/New_York",
    },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("an order names its seller by staff member and by name", () => {
  const ring = async (who: string) => {
    const product = await prisma.product.findFirst();
    const item = product ?? (await sofa());
    return call(createFromCart, who, {
      body: {
        storeLocation: store.name,
        items: [{ productId: item.id, quantity: 1, unitPrice: 1000, discounts: [] }],
      },
    });
  };

  it("a sale rung at the register is linked to the cashier", async () => {
    const pat = await makeStaff("pat", "Pat Lindqvist", "REGISTER");

    const sold = await ring("pat");

    expect(sold.status).toBe(201);
    // The name was written and the link left empty.
    expect(await sellerOf(sold.body.id)).toEqual({
      salesPersonId: pat.id,
      salesperson: "Pat Lindqvist",
    });
  });

  it("a session with no staff row names its email and links nobody", async () => {
    await prisma.user.create({ data: { id: "temp", email: "temp@example.com" } });

    const sold = await ring("temp");

    expect(sold.status).toBe(201);
    expect(await sellerOf(sold.body.id)).toEqual({
      salesPersonId: null,
      salesperson: "temp@example.com",
    });
  });

  it("a duplicated order is linked to whoever copied it, not to its first seller", async () => {
    await makeStaff("pat", "Pat Lindqvist", "REGISTER");
    const dee = await makeStaff("dee", "Dee Okafor", "DESIGNER");
    const sold = await ring("pat");

    const copy = await call(duplicateHandler, "dee", { query: { id: String(sold.body.id) } });

    expect(copy.status).toBe(201);
    expect(await sellerOf(copy.body.id)).toEqual({
      salesPersonId: dee.id,
      salesperson: "Dee Okafor",
    });
  });

  it("a house call's order is linked to its designer", async () => {
    await makeStaff("mia", "Mia Castellano", "MANAGER");
    const dee = await makeStaff("dee", "Dee Okafor", "DESIGNER");
    const customer = await prisma.customer.create({
      data: { firstName: "Ana", lastName: "Reyes" },
    });

    const booked = await through(houseCallsRoute, "mia", {
      body: { customerId: String(customer.id), designerId: String(dee.id) },
    });

    expect(booked.status).toBe(201);
    expect(await sellerOf(booked.body.salesOrderId)).toEqual({
      salesPersonId: dee.id,
      salesperson: "Dee Okafor",
    });
  });

  it("a house call with no designer has no seller", async () => {
    await makeStaff("mia", "Mia Castellano", "MANAGER");
    const customer = await prisma.customer.create({
      data: { firstName: "Ana", lastName: "Reyes" },
    });

    const booked = await through(houseCallsRoute, "mia", {
      body: { customerId: String(customer.id) },
    });

    expect(booked.status).toBe(201);
    expect(await sellerOf(booked.body.salesOrderId)).toEqual({
      salesPersonId: null,
      salesperson: null,
    });
  });

  it("a converted proposal carries its salesperson's name as well as the link", async () => {
    await makeStaff("mia", "Mia Castellano", "MANAGER");
    const dee = await makeStaff("dee", "Dee Okafor", "DESIGNER");
    const customer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed" },
    });
    const proposal = await prisma.proposal.create({
      data: {
        proposalNumber: "PR-0001",
        customerId: customer.id,
        salesPersonId: dee.id,
        lineItems: {
          create: [{ itemName: "Belgian Linen", cost: 8, retailPrice: 30, quantity: 10 }],
        },
      },
    });

    const converted = await through(convertRoute, "mia", { query: { id: String(proposal.id) } });

    expect(converted.status).toBe(201);
    const order = await prisma.salesOrder.findFirstOrThrow({
      where: { customerId: customer.id },
      select: { salesPersonId: true, salesperson: true },
    });
    // The link was written and the name left empty: "Unassigned" in every list
    // that reads the name.
    expect(order).toEqual({ salesPersonId: dee.id, salesperson: "Dee Okafor" });
  });
});
