// /app/__tests__/integration/catalogAdminGates.integration.test.ts
//
// Catalog, vendor and admin-tool routes that took MANAGER/ADMIN-style role
// lists answer to permission keys now (the 2026-11 role-list sweep), and the
// two vendor-order import pages open on "Receive stock" (purchasing.receive).
//
// - Creating a product and the line-item relink follow "Edit catalog"
//   (catalog.write): Buyers, Data Entry, Department Heads and General
//   Managers gain them, whose catalog pages already admitted them.
// - A vendor's contacts read on "View purchasing" or "Edit catalog" and change
//   on "Edit catalog", so Designers and Warehouse keep reading them and stop
//   adding and removing them.
// - Admin-only tools follow their screens' keys, so a Manager loses the
//   traffic sync log, the diagnostic lookup and goals, and Marketing loses
//   product pairings: API-only access to screens they cannot open.
//
// Real routes, real gates, real database; only the session readers and
// redirect are mocked.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import basicProductRoute from "@/pages/api/products/basic";
import quickCreateRoute from "@/pages/api/products/quick-create";
import relinkRoute from "@/pages/api/admin/relink-line-items";
import contactsRoute from "@/pages/api/vendors/[id]/contacts/index";
import trafficLogRoute from "@/pages/api/admin/automations/axper-traffic/recent";
import lookupRoute from "@/pages/api/diagnostics/lookup-test";
import goalsRoute from "@/pages/api/goals/index";
import pairingsRoute from "@/pages/api/admin/product-pairings/index";
import pairingRoute from "@/pages/api/admin/product-pairings/[id]";
import bookingsRoute from "@/pages/api/bookings/index";
import templateRoute from "@/pages/api/templates/[id]";
import ImportOrderPage from "@/app/(dashboard)/app/purchasing/import-order/page";
import ImportApparelPage from "@/app/(dashboard)/app/purchasing/import-apparel/page";

const sessionMock = getServerSession as jest.Mock;

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

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

async function call(
  route: Route,
  userId: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<TestRes> {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
  const res = makeRes();
  await route({ method, query, body, headers: {}, cookies: {} } as unknown as NextApiRequest, res);
  return res;
}

/** Does this page let the person in? It redirects home when it doesn't. */
async function opens(page: () => Promise<unknown>, userId: string): Promise<boolean> {
  (getToken as jest.Mock).mockResolvedValue({ id: userId });
  (headers as jest.Mock).mockResolvedValue(new Headers());
  (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  try {
    await page();
    return true;
  } catch (e) {
    if (e instanceof Error && e.message === "REDIRECT /app") return false;
    throw e;
  }
}

/** A signed-in staff member holding a built-in role (enum and roleId agree). */
async function makeStaff(userId: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: roleKey as never,
      roleId: role.id,
    },
  });
}

let vendorId: number;
let departmentId: number;
let categoryId: number;
let contactId: number;

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  invalidateAppSettingsCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("ada", "ADMIN");

  const vendor = await prisma.vendor.create({ data: { name: "Heron & Wren Workshop" } });
  vendorId = vendor.id;
  const department = await prisma.department.create({ data: { name: "Case Goods" } });
  departmentId = department.id;
  const category = await prisma.category.create({
    data: { name: "Sideboards", departmentId },
  });
  categoryId = category.id;
  const contact = await prisma.vendorContact.create({
    data: { vendorId, name: "Ines Ortega", email: "ines@example.com" },
  });
  contactId = contact.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const basicProduct = (productNumber: string) => ({
  name: "Harbor Sideboard",
  productNumber,
  vendorId: String(vendorId),
  departmentId: String(departmentId),
  categoryId: String(categoryId),
  cost: "450",
  retail: "1000",
});

describe("creating a product follows Edit catalog", () => {
  it("a Buyer creates a basic product; a Designer is refused", async () => {
    await makeStaff("bo", "BUYER");
    await makeStaff("dana", "DESIGNER");

    const made = await call(basicProductRoute, "bo", {
      method: "POST",
      body: basicProduct("HS-100"),
    });
    expect(made.statusCode).toBe(200);
    expect(await prisma.product.count({ where: { productNumber: "HS-100" } })).toBe(1);

    const refused = await call(basicProductRoute, "dana", {
      method: "POST",
      body: basicProduct("HS-101"),
    });
    expect(refused.statusCode).toBe(403);
    expect(await prisma.product.count({ where: { productNumber: "HS-101" } })).toBe(0);
  });

  it("Data Entry creates one from the Detailed Sales drilldown; a Designer is refused", async () => {
    await makeStaff("dee", "DATA_ENTRY");
    await makeStaff("dana", "DESIGNER");
    const product = (productNumber: string) => ({
      name: "Wren Lamp",
      productNumber,
      vendorId,
      departmentId,
      categoryId,
    });

    const made = await call(quickCreateRoute, "dee", {
      method: "POST",
      body: product("WL-200"),
    });
    expect(made.statusCode).toBe(200);
    expect(made.body.productNumber).toBe("WL-200");

    const refused = await call(quickCreateRoute, "dana", {
      method: "POST",
      body: product("WL-201"),
    });
    expect(refused.statusCode).toBe(403);
    expect(await prisma.product.count({ where: { productNumber: "WL-201" } })).toBe(0);
  });
});

describe("the line-item relink follows Change settings or Edit catalog", () => {
  it("a Buyer and a Manager count and relink; a report reader without either key is refused", async () => {
    await makeStaff("bo", "BUYER");
    await makeStaff("mia", "MANAGER");
    await makeStaff("hal", "HR");

    for (const who of ["bo", "mia"]) {
      expect({ who, status: (await call(relinkRoute, who)).statusCode }).toEqual({
        who,
        status: 200,
      });
    }
    expect((await call(relinkRoute, "bo", { method: "POST" })).statusCode).toBe(200);

    expect((await call(relinkRoute, "hal")).statusCode).toBe(403);
    expect((await call(relinkRoute, "hal", { method: "POST" })).statusCode).toBe(403);
  });
});

describe("a vendor's contacts", () => {
  const vendorQuery = () => ({ id: String(vendorId) });

  it("Designers and Warehouse still read them, but no longer add or remove them", async () => {
    await makeStaff("dana", "DESIGNER");
    await makeStaff("wes", "WAREHOUSE");

    const list = await call(contactsRoute, "dana", { query: vendorQuery() });
    expect(list.statusCode).toBe(200);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(["Ines Ortega"]);
    expect((await call(contactsRoute, "wes", { query: vendorQuery() })).statusCode).toBe(200);

    const add = await call(contactsRoute, "dana", {
      method: "POST",
      query: vendorQuery(),
      body: { name: "Mara Quill", email: "mara@example.com" },
    });
    expect(add.statusCode).toBe(403);
    expect(add.body.error).toBe(
      "Adding or removing a vendor contact needs the Edit catalog permission.",
    );

    const remove = await call(contactsRoute, "wes", {
      method: "DELETE",
      query: { ...vendorQuery(), contactId: String(contactId) },
    });
    expect(remove.statusCode).toBe(403);
    expect(await prisma.vendorContact.count()).toBe(1);
  });

  it("a Buyer adds and removes them", async () => {
    await makeStaff("bo", "BUYER");

    const add = await call(contactsRoute, "bo", {
      method: "POST",
      query: vendorQuery(),
      body: { name: "Mara Quill", email: "mara@example.com" },
    });
    expect(add.statusCode).toBe(201);

    const remove = await call(contactsRoute, "bo", {
      method: "DELETE",
      query: { ...vendorQuery(), contactId: String(contactId) },
    });
    expect(remove.statusCode).toBe(204);
    expect((await prisma.vendorContact.findMany()).map((c) => c.name)).toEqual(["Mara Quill"]);
  });

  it("Register and Marketing are refused them", async () => {
    await makeStaff("reg", "REGISTER");
    await makeStaff("max", "MARKETING");

    expect((await call(contactsRoute, "reg", { query: vendorQuery() })).statusCode).toBe(403);
    expect((await call(contactsRoute, "max", { query: vendorQuery() })).statusCode).toBe(403);
  });
});

describe("admin tools follow their screens' keys", () => {
  const lookup = { method: "POST", body: { identifier: "NO-SUCH-UPC" } };

  it("a Manager no longer reaches the traffic sync log, the diagnostic lookup or goals", async () => {
    await makeStaff("mia", "MANAGER");

    expect((await call(trafficLogRoute, "mia")).statusCode).toBe(403);
    expect((await call(lookupRoute, "mia", lookup)).statusCode).toBe(403);
    expect((await call(goalsRoute, "mia")).statusCode).toBe(403);
  });

  it("Marketing no longer edits product pairings", async () => {
    await makeStaff("max", "MARKETING");

    expect((await call(pairingsRoute, "max")).statusCode).toBe(403);
    const missing = { method: "DELETE", query: { id: "999999" } };
    expect((await call(pairingRoute, "max", missing)).statusCode).toBe(403);
  });

  it("bookings and label templates stay with the Administrator", async () => {
    await makeStaff("mia", "MANAGER");

    expect((await call(bookingsRoute, "mia")).statusCode).toBe(403);
    expect((await call(templateRoute, "mia", { query: { id: "999999" } })).statusCode).toBe(403);
  });

  it("the Administrator and the Owner reach every one of them", async () => {
    await makeStaff("sam", "SUPER_ADMIN");

    for (const who of ["ada", "sam"]) {
      const statuses = {
        trafficLog: (await call(trafficLogRoute, who)).statusCode,
        // Nothing matches, which the tool answers with a 404 past its gate.
        lookup: (await call(lookupRoute, who, lookup)).statusCode,
        goals: (await call(goalsRoute, who)).statusCode,
        pairings: (await call(pairingsRoute, who)).statusCode,
        bookings: (await call(bookingsRoute, who)).statusCode,
        // No such template: a 404 past the gate.
        template: (await call(templateRoute, who, { query: { id: "999999" } })).statusCode,
      };
      expect({ who, statuses }).toEqual({
        who,
        statuses: {
          trafficLog: 200,
          lookup: 404,
          goals: 200,
          pairings: 200,
          bookings: 200,
          template: 404,
        },
      });
    }
  });
});

describe("the vendor-order import pages open on Receive stock", () => {
  const PAGES: Array<[string, () => Promise<unknown>]> = [
    ["import-order", () => ImportOrderPage()],
    ["import-apparel", () => ImportApparelPage()],
  ];

  it("admits the roles that hold it and refuses those that don't", async () => {
    const roles: Array<[string, string, boolean]> = [
      // Admitted before, and still.
      ["sam", "SUPER_ADMIN", true],
      ["mia", "MANAGER", true],
      ["wes", "WAREHOUSE", true],
      // Gained: they hold Receive stock, the key of the preview step.
      ["bo", "BUYER", true],
      ["gm", "GENERAL_MANAGER", true],
      // Refused, as before: no Receive stock.
      ["dee", "DATA_ENTRY", false],
      ["dana", "DESIGNER", false],
      ["dh", "DEPARTMENT_HEAD", false],
    ];
    for (const [who, role] of roles) await makeStaff(who, role);

    for (const [name, page] of PAGES) {
      const seen: Array<[string, boolean]> = [];
      for (const [who] of roles) seen.push([who, await opens(page, who)]);
      expect({ page: name, seen }).toEqual({
        page: name,
        seen: roles.map(([who, , admitted]) => [who, admitted]),
      });
    }
  });
});
