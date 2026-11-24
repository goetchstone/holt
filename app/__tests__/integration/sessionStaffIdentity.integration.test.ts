// /app/__tests__/integration/sessionStaffIdentity.integration.test.ts
//
// Who a request acts as is the staff row linked to the session's User id,
// never the row whose email matches the session's email.
//
// Every gate resolves the caller by `userId`, but until 2026-11-21 thirteen
// routes then looked the caller up again by `StaffMember.email`, with no
// `userId` and no `isActive` filter. Anyone who can write a staff member's email
// (staff.manage: People Operations, the General Manager) decided whose row
// those routes acted as: a General Manager who gave the Owner's row their own
// session email opened tills as the Owner, saw the Owner's pipeline, and moved
// the Owner's active store. `sessionStaffMember` (lib/auth/roleAssignment.ts)
// is now the one lookup. Real database, real gates, real route handlers.

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
import pipelineRoute from "@/pages/api/sales/pipeline/index";
import openTillRoute from "@/pages/api/registers/[id]/tills/open";
import activeStoreRoute from "@/pages/api/staff/active-store";
import transfersRoute from "@/pages/api/warehouse/transfers/index";

const sessionMock = getServerSession as jest.Mock;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
  return {
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
    end(payload?: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as TestRes;
}

function makeReq(over: Partial<NextApiRequest> = {}): NextApiRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { method: "GET", query: {}, body: {}, cookies: {}, ...over } as any;
}

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  over: Partial<NextApiRequest>,
): Promise<TestRes> {
  const res = makeRes();
  await route(makeReq(over), res);
  return res;
}

/** A signed-in staff member on a built-in role (enum and Role row agree). */
async function makeStaff(userId: string, roleKey: string) {
  const email = `${userId}@example.com`;
  await prisma.user.create({ data: { id: userId, email } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      email,
      displayName: userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: roleKey as any,
      roleId: role.id,
    },
  });
}

/** The session NextAuth mints for `userId`: its User id and its User email. */
function sessionFor(userId: string): Session {
  return { user: { id: userId, email: `${userId}@example.com` } } as Session;
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue(sessionFor(userId));
  invalidateRoleGrantCache();
}

let quoteNumber = 0;
function makeQuote(salesPersonId: number) {
  quoteNumber += 1;
  return prisma.salesOrder.create({
    data: {
      orderno: `SSI-${quoteNumber}`,
      status: "QUOTE",
      salesPersonId,
      orderDate: new Date(),
      quoteDate: new Date(),
    },
  });
}

let owner: { id: number };
let gm: { id: number };

beforeEach(async () => {
  await resetTestDb();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  owner = await makeStaff("owner", "SUPER_ADMIN");
  gm = await makeStaff("gm", "GENERAL_MANAGER");
  // The swap a staff.manage holder can make on the Staff screen: the GM's row
  // gets another address, and the Owner's row gets the GM's session email.
  await prisma.staffMember.update({
    where: { id: gm.id },
    data: { email: "gm.renamed@example.com" },
  });
  await prisma.staffMember.update({
    where: { id: owner.id },
    data: { email: "gm@example.com" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a route acts as the session's own staff row, whatever the emails say", () => {
  it("GET /api/sales/pipeline shows the General Manager their own pipeline", async () => {
    const ownersQuote = await makeQuote(owner.id);
    const gmsQuote = await makeQuote(gm.id);
    signInAs("gm");

    const res = await call(pipelineRoute, { method: "GET", query: {} });

    expect(res.statusCode).toBe(200);
    expect(res.body.myStaffId).toBe(gm.id);
    const ids = res.body.quotes.map((q: { id: number }) => q.id);
    expect(ids).toContain(gmsQuote.id);
    expect(ids).not.toContain(ownersQuote.id);
  });

  it("POST /api/registers/[id]/tills/open records the General Manager as the opener", async () => {
    const store = await prisma.storeLocation.create({
      data: { name: "Main", code: "MAIN", type: "STORE" },
    });
    const register = await prisma.register.create({
      data: { name: "Front Desk", storeLocationId: store.id },
    });
    signInAs("gm");

    const res = await call(openTillRoute, {
      method: "POST",
      query: { id: String(register.id) },
      body: { openingCash: 100 },
    });

    expect(res.statusCode).toBe(201);
    const till = await prisma.till.findFirstOrThrow({ where: { registerId: register.id } });
    expect(till.openedById).toBe(gm.id);
  });

  it("PUT /api/staff/active-store moves the General Manager's store, not the Owner's", async () => {
    const store = await prisma.storeLocation.create({
      data: { name: "Annex", code: "ANNEX", type: "STORE" },
    });
    signInAs("gm");

    const res = await call(activeStoreRoute, {
      method: "PUT",
      body: { storeLocationId: store.id },
    });

    expect(res.statusCode).toBe(200);
    const rows = await prisma.staffMember.findMany({
      where: { id: { in: [owner.id, gm.id] } },
      select: { id: true, activeStoreLocationId: true },
    });
    const storeOf = new Map(rows.map((r) => [r.id, r.activeStoreLocationId]));
    expect(storeOf.get(gm.id)).toBe(store.id);
    expect(storeOf.get(owner.id)).toBeNull();
  });

  it("POST /api/warehouse/transfers records the session's own User as the requester", async () => {
    // The same shape on User: the session's email now belongs to another User
    // row. The route used to look the requester up by that email.
    await prisma.user.update({ where: { id: "owner" }, data: { email: "owner.user@example.com" } });
    await prisma.user.create({ data: { id: "other", email: "owner@example.com" } });
    const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
    const dept = await prisma.department.create({ data: { name: "Living Room" } });
    const category = await prisma.category.create({
      data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
    });
    const product = await prisma.product.create({
      data: {
        productNumber: "HS-1",
        name: "Harbour Sofa",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: category.id,
      },
    });
    const from = await prisma.storeLocation.create({
      data: { name: "Store A", code: "SA", type: "STORE" },
    });
    const to = await prisma.storeLocation.create({
      data: { name: "Store B", code: "SB", type: "STORE" },
    });
    signInAs("owner");

    const res = await call(transfersRoute, {
      method: "POST",
      body: { productId: product.id, quantity: 1, fromLocationId: from.id, toLocationId: to.id },
    });

    expect(res.statusCode).toBe(201);
    const transfer = await prisma.inventoryTransfer.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(transfer.requestedByUserId).toBe("owner");
  });
});
