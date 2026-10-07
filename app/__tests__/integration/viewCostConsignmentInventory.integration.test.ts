// /app/__tests__/integration/viewCostConsignmentInventory.integration.test.ts
//
// "View cost" (catalog.cost, SEC-14) over consignment rug cost: the consignment
// list and item page, the count and return scanners, receiving gaps and the
// returns history. Each route keeps its own gate and audience; a caller
// without View cost gets the same rugs without cost (strip, never deny), and an
// edit from a screen that never received cost cannot overwrite it. Tag prices
// (anchor, retail) stay for everyone, by decision.
//
// Real routes, real gates, real database; next-auth's session is the only mock.

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
import itemsRoute from "@/pages/api/consignment/items/index";
import itemRoute from "@/pages/api/consignment/items/[id]";
import scanRoute from "@/pages/api/consignment/scan";
import gapsRoute from "@/pages/api/consignment/receiving-gaps";
import returnsRoute from "@/pages/api/consignment/vendor-returns";

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

async function call(
  route: Route,
  userId: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: object; body?: object } = {},
) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
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
  await route({ method, query, body, cookies: {} } as unknown as NextApiRequest, res);
  return { status, body: JSON.parse(JSON.stringify(payload ?? null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Every key at every depth that carries cost (the visibility flag excepted). */
function costKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(costKeys);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/cost|amount/i.test(k) && k !== "costVisible" ? [k] : []),
      ...costKeys(v),
    ]);
  }
  return [];
}

async function makeStaff(userId: string, roleKey: string, enumRole = roleKey) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: enumRole as never,
      roleId: role.id,
      isActive: true,
    },
  });
}

const w: Record<string, { id: number }> = {};

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });

  // A holder, and an ADMIN whose View cost the owner has unticked: ADMIN passes
  // every gate here (the MANAGER/ADMIN/WAREHOUSE list and the inline
  // MANAGER/ADMIN check on receiving gaps included).
  await makeStaff("mia", "MANAGER");
  await makeStaff("ada", "ADMIN");
  const admin = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.rolePermission.deleteMany({
    where: { roleId: admin.id, permission: "catalog.cost" },
  });
  await prisma.role.update({ where: { id: admin.id }, data: { grantsCustomized: true } });
  // A custom role that runs the rug floor, without View cost.
  await prisma.role.create({
    data: {
      key: "RUG_FLOOR",
      name: "Rug floor",
      isSystem: false,
      permissions: {
        create: ["purchasing.receive", "inventory.count", "inventory.transfer"].map(
          (permission) => ({ permission }),
        ),
      },
    },
  });
  await makeStaff("ray", "RUG_FLOOR", "DESIGNER");
  invalidateRoleGrantCache();

  const vendor = await prisma.vendor.create({ data: { name: "Kilim House" } });
  w.vendor = vendor;
  const batch = await prisma.consignmentPaymentBatch.create({
    data: {
      vendorId: vendor.id,
      periodStart: new Date("2026-09-01T00:00:00Z"),
      periodEnd: new Date("2026-09-30T00:00:00Z"),
      totalAmount: 100,
      checkNumber: "1001",
    },
  });
  w.rug = await prisma.consignmentItem.create({
    data: {
      vendorId: vendor.id,
      barcode: "RUG-1",
      cost: 100,
      anchorPrice: 700,
      retailPrice: 350,
      quality: "Hand-knotted",
      status: "ON_FLOOR",
      consignmentPaymentBatchId: batch.id,
    },
  });
  const ret = await prisma.consignmentVendorReturn.create({ data: { vendorId: vendor.id } });
  await prisma.consignmentItem.create({
    data: {
      vendorId: vendor.id,
      barcode: "RUG-2",
      cost: 60,
      anchorPrice: 420,
      retailPrice: 210,
      status: "RETURNED_VENDOR",
      vendorReturnId: ret.id,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ROUTES: Array<[string, Route, () => { method?: string; query?: object; body?: object }]> = [
  ["consignment list", itemsRoute, () => ({})],
  ["item page", itemRoute, () => ({ query: { id: String(w.rug.id) } })],
  ["count/return scanner", scanRoute, () => ({ method: "POST", body: { barcode: "RUG-1" } })],
  ["receiving gaps (unlinked)", gapsRoute, () => ({ query: { type: "unlinked" } })],
  ["returns history", returnsRoute, () => ({})],
];

describe("consignment rug cost follows View cost", () => {
  it.each(ROUTES)("%s: a holder gets the cost", async (_name, route, opts) => {
    const { status, body } = await call(route, "mia", opts());
    expect(status).toBe(200);
    expect(body.costVisible).toBe(true);
    expect(costKeys(body).length).toBeGreaterThan(0);
  });

  it.each(ROUTES)(
    "%s: an admin with View cost unticked gets the same rugs without cost, not a refusal",
    async (_name, route, opts) => {
      const { status, body } = await call(route, "ada", opts());
      expect(status).toBe(200);
      expect(body.costVisible).toBe(false);
      expect(costKeys(body)).toEqual([]);
    },
  );

  it("a custom floor role without View cost: the same, on its permission-key routes", async () => {
    for (const [route, opts] of [
      [itemsRoute, {}],
      [scanRoute, { method: "POST", body: { barcode: "RUG-1" } }],
      [returnsRoute, {}],
    ] as const) {
      const { status, body } = await call(route, "ray", opts);
      expect(status).toBe(200);
      expect(body.costVisible).toBe(false);
      expect(costKeys(body)).toEqual([]);
    }
  });

  it("tag prices stay for everyone, and the figures a holder sees are the rug's", async () => {
    const blind = (await call(scanRoute, "ada", { method: "POST", body: { barcode: "RUG-1" } }))
      .body;
    expect(blind).toMatchObject({ anchorPrice: 700, retailPrice: 350 });
    const holder = (await call(itemRoute, "mia", { query: { id: String(w.rug.id) } })).body;
    expect(holder.cost).toBe(100);
    // The item page sends the payment batch's identity, never its total, to anyone.
    expect(holder.consignmentPaymentBatch).toMatchObject({ checkNumber: "1001", isPaid: false });
    expect(holder.consignmentPaymentBatch.totalAmount).toBeUndefined();
  });
});

describe("an edit from a screen without cost leaves the cost alone", () => {
  async function storedCost() {
    return Number(
      (await prisma.consignmentItem.findUniqueOrThrow({ where: { id: w.rug.id } })).cost,
    );
  }

  it("a blind caller's PUT never writes cost, even 0 or null", async () => {
    const { body } = await call(itemRoute, "ada", { query: { id: String(w.rug.id) } });
    for (const cost of [0, null]) {
      const put = await call(itemRoute, "ada", {
        method: "PUT",
        query: { id: String(w.rug.id) },
        body: { quality: body.quality, size: "8x10", cost },
      });
      expect(put.status).toBe(200);
      expect(costKeys(put.body)).toEqual([]);
      expect(await storedCost()).toBe(100);
    }
  });

  it("a holder cannot blank cost with anything that is not a cost, and can change it", async () => {
    for (const cost of [null, "", "   ", -1, "abc", false, []]) {
      const bad = await call(itemRoute, "mia", {
        method: "PUT",
        query: { id: String(w.rug.id) },
        body: { cost },
      });
      expect({ cost, status: bad.status }).toEqual({ cost, status: 400 });
      expect(await storedCost()).toBe(100);
    }

    const ok = await call(itemRoute, "mia", {
      method: "PUT",
      query: { id: String(w.rug.id) },
      body: { cost: 250 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.cost).toBe(250);
    expect(await storedCost()).toBe(250);
  });

  it("a blind caller's new rug keeps the cost they typed; the echo leaves it out", async () => {
    const created = await call(itemsRoute, "ray", {
      method: "POST",
      body: { barcode: "RUG-3", vendorId: w.vendor.id, cost: 80 },
    });
    expect(created.status).toBe(201);
    expect(costKeys(created.body)).toEqual([]);
    const stored = await prisma.consignmentItem.findUniqueOrThrow({ where: { barcode: "RUG-3" } });
    expect(Number(stored.cost)).toBe(80);
  });
});
