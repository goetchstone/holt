// /app/__tests__/integration/inventoryPurchasingGates.integration.test.ts
//
// Who may open Credits Owed, PO Management, Receiving Gaps, Inventory Freeze,
// Needs Ordering and Receiving Records, and use the consignment routes behind
// them. Until the 2026-11 role-list sweep these were role lists, and three
// Receiving Gaps routes asked for a key AND for the staff role to be MANAGER or
// ADMIN by name. So the Owner (SUPER_ADMIN), the General Manager and every
// custom role (whose enum is DESIGNER) got 403 on the page's list, its Link to
// Receipt and its Assign Location; the e2e Owner run listed the page as a known
// failure. The item route's MANAGER/ADMIN/WAREHOUSE list refused the rug to
// most of the roles its page admits.
//
// Now each screen and route decides on one permission key, so who may is the
// store's configuration. Each is asked as every built-in role, as seeded, and
// as a custom role holding one key, and must admit exactly that key's holders.
//
// Real routes, pages and gates on the real database; the session readers and
// redirect are the only mocks, besides the pages' client views, which
// helpers/pageWithoutClientViews.ts stubs so they never load.

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
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { BUILT_IN_ROLES } from "@/lib/auth/permissionCatalog";
import gapsRoute from "@/pages/api/consignment/receiving-gaps";
import linkReceiptRoute from "@/pages/api/consignment/bulk-link-receipt";
import assignLocationRoute from "@/pages/api/consignment/bulk-assign-location";
import itemRoute from "@/pages/api/consignment/items/[id]";
import markSoldRoute from "@/pages/api/consignment/items/mark-sold";
import { pageWithoutClientViews, type ServerPage } from "../helpers/pageWithoutClientViews";

let CreditsOwedPage: ServerPage;
let POManagementPage: ServerPage;
let ReceivingGapsPage: ServerPage;
let InventoryFreezePage: ServerPage;
let NeedsOrderingPage: ServerPage;
let ReceivingListPage: ServerPage;
beforeAll(async () => {
  CreditsOwedPage = await pageWithoutClientViews(
    "@/app/(dashboard)/app/inventory/consignment/credits-owed/page",
  );
  POManagementPage = await pageWithoutClientViews(
    "@/app/(dashboard)/app/inventory/consignment/po-management/page",
  );
  ReceivingGapsPage = await pageWithoutClientViews(
    "@/app/(dashboard)/app/inventory/consignment/receiving-gaps/page",
  );
  InventoryFreezePage = await pageWithoutClientViews("@/app/(dashboard)/app/inventory/freeze/page");
  NeedsOrderingPage = await pageWithoutClientViews(
    "@/app/(dashboard)/app/purchasing/needs-ordering/page",
  );
  ReceivingListPage = await pageWithoutClientViews(
    "@/app/(dashboard)/app/purchasing/receiving/page",
  );
});

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
type Page = () => Promise<unknown>;

// Who holds each key by default (BUILT_IN_ROLES in permissionCatalog.ts; the
// Owner by its wildcard). Written out rather than read from the catalog, so a
// gate on another key, or one that still reads the role's name, disagrees.
const HOLDERS: Record<string, string[]> = {
  "accounting.read": ["SUPER_ADMIN", "ADMIN", "GENERAL_MANAGER", "MANAGER"],
  "inventory.adjust": ["SUPER_ADMIN", "ADMIN", "GENERAL_MANAGER", "MANAGER"],
  "inventory.count": [
    "SUPER_ADMIN",
    "ADMIN",
    "GENERAL_MANAGER",
    "DEPARTMENT_HEAD",
    "MANAGER",
    "WAREHOUSE",
  ],
  "inventory.read": [
    "SUPER_ADMIN",
    "ADMIN",
    "GENERAL_MANAGER",
    "DEPARTMENT_HEAD",
    "BUYER",
    "DATA_ENTRY",
    "MANAGER",
    "DESIGNER",
    "REGISTER",
    "WAREHOUSE",
  ],
  "inventory.transfer": ["SUPER_ADMIN", "ADMIN", "GENERAL_MANAGER", "MANAGER", "WAREHOUSE"],
  "purchasing.receive": [
    "SUPER_ADMIN",
    "ADMIN",
    "GENERAL_MANAGER",
    "BUYER",
    "MANAGER",
    "WAREHOUSE",
  ],
  "purchasing.write": ["SUPER_ADMIN", "ADMIN", "GENERAL_MANAGER", "BUYER", "DATA_ENTRY", "MANAGER"],
};

/** The custom role, and its one staff member, that holds only `key`. */
const only = (key: string) => `ONLY_${key.replace(/\W/g, "_").toUpperCase()}`;

const BUILT_IN = BUILT_IN_ROLES.map((r) => r.key);
const CALLERS = [...BUILT_IN, ...Object.keys(HOLDERS).map(only)];

const emailOf = (userId: string) => `${userId.toLowerCase()}@example.com`;

/** An active staff member whose user id is `userId`, on the role `roleKey`. */
async function makeStaff(userId: string, roleKey: string, enumRole = roleKey) {
  await prisma.user.create({ data: { id: userId, email: emailOf(userId) } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: emailOf(userId),
      role: enumRole as never,
      roleId: role.id,
      isActive: true,
    },
  });
}

async function call(
  route: Route,
  userId: string,
  method: string,
  { query = {}, body = {} }: { query?: object; body?: object } = {},
) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: emailOf(userId) },
  });
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
  await route({ method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest, res);
  return { status, body: JSON.parse(JSON.stringify(payload ?? null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Does the server page render for this viewer? A refusal redirects to /app. */
async function opens(page: Page, userId: string): Promise<boolean> {
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

/**
 * Does the route let this caller past its gate? A refusal is 403; a caller let
 * through gets the handler's own answer, `reached`. Anything else is a failure.
 */
function passes(
  route: Route,
  method: string,
  request: () => { query?: object; body?: object },
  reached: number,
) {
  return async (userId: string) => {
    const { status } = await call(route, userId, method, request());
    if (status === 403) return false;
    if (status === reached) return true;
    throw new Error(`${method} as ${userId} answered ${status}, expected 403 or ${reached}`);
  };
}

const w: Record<string, { id: number }> = {};

async function newRug(barcode: string) {
  return prisma.consignmentItem.create({
    data: { vendorId: w.vendor.id, barcode, cost: 100, anchorPrice: 700, retailPrice: 350 },
  });
}

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  for (const key of Object.keys(HOLDERS)) {
    await prisma.role.create({
      data: {
        key: only(key),
        name: only(key),
        isSystem: false,
        permissions: { create: [{ permission: key }] },
      },
    });
  }
  invalidateRoleGrantCache();
  for (const roleKey of BUILT_IN) await makeStaff(roleKey, roleKey);
  // Giving someone a custom role writes the enum DESIGNER (roleAssignment.ts).
  for (const key of Object.keys(HOLDERS)) await makeStaff(only(key), only(key), "DESIGNER");

  w.vendor = await prisma.vendor.create({ data: { name: "Kilim House", isConsignment: true } });
  w.store = await prisma.storeLocation.create({
    data: { name: "Showroom", code: "SHOW", type: "STORE" },
  });
  w.rug = await newRug("RUG-1");
});

afterAll(async () => {
  await prisma.$disconnect();
});

// A write is asked with an empty list or a bad id, which its handler refuses
// with 400 once the gate has let the caller through, so the sweep writes nothing.
const GATES: Array<[string, string, (userId: string) => Promise<boolean>]> = [
  ["the Credits Owed page", "accounting.read", (u) => opens(CreditsOwedPage, u)],
  ["the PO Management page", "accounting.read", (u) => opens(POManagementPage, u)],
  ["the Receiving Gaps page", "accounting.read", (u) => opens(ReceivingGapsPage, u)],
  ["the Inventory Freeze page", "inventory.count", (u) => opens(InventoryFreezePage, u)],
  ["the Needs Ordering page", "purchasing.receive", (u) => opens(NeedsOrderingPage, u)],
  ["the Receiving Records page", "purchasing.receive", (u) => opens(ReceivingListPage, u)],
  ["the receiving gaps list", "accounting.read", passes(gapsRoute, "GET", () => ({}), 200)],
  [
    "Link to Receipt",
    "purchasing.write",
    passes(linkReceiptRoute, "POST", () => ({ body: { itemIds: [] } }), 400),
  ],
  [
    "Assign Location",
    "inventory.adjust",
    passes(assignLocationRoute, "POST", () => ({ body: { itemIds: [] } }), 400),
  ],
  [
    "the item page's rug",
    "inventory.read",
    passes(itemRoute, "GET", () => ({ query: { id: String(w.rug.id) } }), 200),
  ],
  [
    "Mark Missing and Found",
    "inventory.transfer",
    passes(itemRoute, "PUT", () => ({ query: { id: "not-a-rug" } }), 400),
  ],
  [
    "Mark Sold",
    "inventory.transfer",
    passes(markSoldRoute, "POST", () => ({ body: { itemIds: [] } }), 400),
  ],
];

describe("each screen and route admits exactly the holders of its key", () => {
  it.each(GATES)("%s (%s)", async (_name, key, admits) => {
    const admitted: string[] = [];
    for (const userId of CALLERS) {
      if (await admits(userId)) admitted.push(userId);
    }
    expect(admitted.sort()).toEqual([...HOLDERS[key], only(key)].sort());
  });
});

describe("Receiving Gaps works end to end for the Owner and the General Manager", () => {
  it.each(["SUPER_ADMIN", "GENERAL_MANAGER"])(
    "%s lists a gap, links the rug to a new receipt and gives it a location",
    async (userId) => {
      const rug = await newRug(`GAP-${userId}`);
      const gaps = await call(gapsRoute, userId, "GET", { query: { type: "unlinked" } });
      expect(gaps.status).toBe(200);
      expect(gaps.body.items.map((i: { id: number }) => i.id)).toContain(rug.id);

      const linked = await call(linkReceiptRoute, userId, "POST", {
        body: { itemIds: [rug.id], vendorId: w.vendor.id, newReceiptDate: "2026-11-20" },
      });
      expect(linked).toMatchObject({ status: 200, body: { linked: 1 } });
      const located = await call(assignLocationRoute, userId, "POST", {
        body: { itemIds: [rug.id], storeLocationId: w.store.id },
      });
      expect(located).toMatchObject({ status: 200, body: { assigned: 1 } });

      expect(
        await prisma.consignmentItem.findUniqueOrThrow({ where: { id: rug.id } }),
      ).toMatchObject({ consignmentReceiptId: linked.body.receiptId, storeLocationId: w.store.id });
    },
  );
});

describe("the consignment item page", () => {
  it("loads the rug for a Designer, whom the page admits; cost only with View cost", async () => {
    const query = { id: String(w.rug.id) };
    const designer = await call(itemRoute, "DESIGNER", "GET", { query });
    expect(designer).toMatchObject({
      status: 200,
      body: { id: w.rug.id, cost: 100, costVisible: true },
    });
    const blind = await call(itemRoute, only("inventory.read"), "GET", { query });
    expect(blind).toMatchObject({ status: 200, body: { id: w.rug.id, costVisible: false } });
    expect(blind.body).not.toHaveProperty("cost");
  });

  it("Mark Missing, Found and Mark Sold are the warehouse's, not a Designer's", async () => {
    const rug = await newRug("ITEM-ACTIONS");
    const query = { id: String(rug.id) };
    const put = (userId: string, status: string) =>
      call(itemRoute, userId, "PUT", { query, body: { status } });
    expect((await put("DESIGNER", "MISSING")).status).toBe(403);
    expect((await put("WAREHOUSE", "MISSING")).status).toBe(200);
    expect((await put("WAREHOUSE", "ON_FLOOR")).status).toBe(200);

    const sale = { itemIds: [rug.id], saleCustomerName: "Ada Lovelace", saleDate: "2026-11-20" };
    expect((await call(markSoldRoute, "DESIGNER", "POST", { body: sale })).status).toBe(403);
    expect(await call(markSoldRoute, "WAREHOUSE", "POST", { body: sale })).toMatchObject({
      status: 200,
      body: { updated: 1 },
    });
    expect((await prisma.consignmentItem.findUniqueOrThrow({ where: { id: rug.id } })).status).toBe(
      "SOLD",
    );
  });
});
