// /app/__tests__/integration/viewCostManagementReports.integration.test.ts
//
// "View cost" (catalog.cost, SEC-14) over the management reports: Gross
// Margin, Top & Bottom Sellers, Sales Explorer, Inventory Health, PO
// Sell-Through and the Buyers Report on the MANAGER/ADMIN role list, and the
// Open PO Gaps page on ADMIN. Each keeps its gate; an admin whose role lost
// View cost gets the same report without cost or margin (strip, never deny),
// in an order that does not give a cost or margin ranking away. Gross Margin
// and the Buyers Report also check she does not get it back by viewing as a
// MANAGER that has it.
//
// Real router, real gates, real database; the tRPC context is built by hand.

jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { FRAME_PUBLIC_FIELDS } from "@/lib/buyPerformance";
import PoGapsPage from "@/app/(dashboard)/app/reports/po-gaps/page";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";

const RANGE = { startDate: "2026-09-01", endDate: "2026-09-30" };

function reportsAs(userId: string, impersonate: string | null = null) {
  const ctx: TrpcContext = {
    userId,
    userEmail: `${userId}@example.com`,
    tokenRole: null,
    impersonate,
    headers: new Headers(),
  };
  return createCallerFactory(appRouter)(ctx).reports;
}

/** Every key at every depth that carries cost, margin or profit (the flag excepted). */
function costKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(costKeys);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/cost|margin|profit|deadPct/i.test(k) && k !== "costVisible" ? [k] : []),
      ...costKeys(v),
    ]);
  }
  return [];
}

async function makeStaff(userId: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: roleKey as never,
      roleId: role.id,
      isActive: true,
    },
  });
}

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });

  // A MANAGER as shipped (the role these reports exist for), an owner, a
  // DESIGNER, and an ADMIN whose View cost the owner has unticked.
  await makeStaff("mia", "MANAGER");
  await makeStaff("sam", "SUPER_ADMIN");
  await makeStaff("dana", "DESIGNER");
  await makeStaff("ada", "ADMIN");
  const admin = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.rolePermission.deleteMany({
    where: { roleId: admin.id, permission: "catalog.cost" },
  });
  await prisma.role.update({ where: { id: admin.id }, data: { grantsCustomized: true } });
  invalidateRoleGrantCache();

  // Two products whose revenue order (Case Goods first) is the reverse of
  // their margin order (Lighting first).
  const vendor = await prisma.vendor.create({ data: { name: "Heron & Wren" } });
  const product = async (
    productNumber: string,
    name: string,
    department: string,
    category: string,
    baseCost: number,
    baseRetail: number,
  ) => {
    const dept = await prisma.department.create({ data: { name: department } });
    const cat = await prisma.category.create({ data: { name: category, departmentId: dept.id } });
    return prisma.product.create({
      data: {
        productNumber,
        name,
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
        baseCost,
        baseRetail,
      },
    });
  };
  const sideboard = await product(
    "MR-100",
    "Heron Sideboard",
    "Case Goods",
    "Sideboards",
    450,
    1000,
  );
  const lamp = await product("MR-200", "Wren Lamp", "Lighting", "Lamps", 50, 300);

  // Stock whose cost order (Case Goods: 2 x 450 = 900, Lighting: 10 x 50 = 500)
  // is the reverse of its retail order (2000 against 3000).
  const store = await prisma.storeLocation.create({
    data: { name: "Harbor Showroom", code: "HAR", type: "STORE" },
  });
  await prisma.inventoryPosition.createMany({
    data: [
      { productId: sideboard.id, storeLocationId: store.id, quantity: 2 },
      { productId: lamp.id, storeLocationId: store.id, quantity: 10 },
    ],
  });

  // A confirmed PO for both, received before the sale, still missing its ESD.
  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: "PO-MGMT-1",
      vendorId: vendor.id,
      status: "CONFIRMED",
      orderDate: new Date("2026-08-20T15:00:00Z"),
    },
  });
  for (const [productId, orderedQuantity, unitCost] of [
    [sideboard.id, 2, 450],
    [lamp.id, 10, 50],
  ]) {
    const item = await prisma.purchaseOrderItem.create({
      data: { purchaseOrderId: po.id, productId, orderedQuantity, unitCost },
    });
    await prisma.receivingRecord.create({
      data: {
        purchaseOrderId: po.id,
        purchaseOrderItemId: item.id,
        quantityReceived: orderedQuantity,
        receivedDate: new Date("2026-09-01T15:00:00Z"),
        receiverUserId: "mia",
      },
    });
  }

  await prisma.salesOrder.create({
    data: {
      orderno: "SO-MGMT-1",
      status: "ORDER",
      orderDate: new Date("2026-09-15T15:00:00Z"),
      storeLocation: "Harbor Showroom",
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: sideboard.id,
            productName: "Heron Sideboard",
            orderedQuantity: 1,
            netPrice: 1000,
            cost: 900, // margin 100
            vatRate: 0,
            vatAmount: 0,
          },
          {
            lineNumber: 2,
            productId: lamp.id,
            productName: "Wren Lamp",
            orderedQuantity: 2,
            netPrice: 600,
            cost: 100, // margin 500
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Gross Margin follows View cost", () => {
  const input = { ...RANGE, pivot: "department" as const };

  it("a holder gets cost, margin and margin %, ordered by margin", async () => {
    const data = await reportsAs("mia").grossMargin(input);
    expect(data.costVisible).toBe(true);
    expect(data.rows.map((r) => r.key)).toEqual(["Lighting", "Case Goods"]);
    expect(data.rows[0]).toMatchObject({ cost: 100, margin: 500, marginPct: expect.any(Number) });
  });

  it("an admin without View cost gets revenue and units, ordered by revenue", async () => {
    const holder = await reportsAs("mia").grossMargin(input);
    const data = await reportsAs("ada").grossMargin(input);
    expect(data.costVisible).toBe(false);
    expect(costKeys(data)).toEqual([]);
    expect(data.rows.map((r) => r.key)).toEqual(["Case Goods", "Lighting"]);
    expect(data.totals).toEqual({
      revenue: holder.totals.revenue,
      units: holder.totals.units,
      lineCount: holder.totals.lineCount,
    });
  });

  it("the gate is unchanged: a DESIGNER is refused", async () => {
    await expect(reportsAs("dana").grossMargin(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("viewing as a MANAGER does not give that admin the cost back; it does show an owner", async () => {
    const viewing = await reportsAs("ada", "MANAGER").grossMargin(input);
    expect(viewing.costVisible).toBe(false);
    expect(costKeys(viewing)).toEqual([]);
    expect(viewing.rows.map((r) => r.key)).toEqual(["Case Goods", "Lighting"]);

    const owner = await reportsAs("sam", "MANAGER").grossMargin(input);
    expect(owner.costVisible).toBe(true);
  });
});

describe("Top & Bottom Sellers follow View cost", () => {
  it("a holder can rank by margin", async () => {
    const data = await reportsAs("mia").topSellers({ ...RANGE, metric: "margin" });
    expect(data).toMatchObject({ metric: "margin", costVisible: true });
    expect(data.top[0].name).toBe("Wren Lamp");
    expect(costKeys(data.top[0]).sort()).toEqual(["cost", "margin", "marginPct"]);
  });

  it("an admin without View cost asking for margin gets a revenue ranking that says so", async () => {
    const data = await reportsAs("ada").topSellers({ ...RANGE, metric: "margin" });
    expect(data).toMatchObject({ metric: "revenue", costVisible: false });
    expect(data.top[0].name).toBe("Heron Sideboard");
    expect(costKeys(data)).toEqual([]);

    const units = await reportsAs("ada").topSellers({ ...RANGE, metric: "units" });
    expect(units.metric).toBe("units");
    expect(units.top[0].name).toBe("Wren Lamp");
  });
});

describe("Sales Explorer follows View cost", () => {
  const input = {
    p1Start: "2026-09-01",
    p1End: "2026-09-30",
    p2Start: "2025-09-01",
    p2End: "2025-09-30",
    pivot: "department" as const,
  };

  it("a holder gets margin % at every node and cost in the totals", async () => {
    const data = await reportsAs("mia").salesExplorer(input);
    expect(data.costVisible).toBe(true);
    expect(data.tree[0].marginPct1).toEqual(expect.any(Number));
    expect(data.totals.period1.cost).toBe(1000);
  });

  it("an admin without View cost gets the same tree and sales, with no cost at any depth", async () => {
    const holder = await reportsAs("mia").salesExplorer(input);
    const data = await reportsAs("ada").salesExplorer(input);
    expect(data.costVisible).toBe(false);
    expect(costKeys(data)).toEqual([]);
    const ids = (nodes: { id: string; children: unknown[] }[]): string[] =>
      nodes.flatMap((n) => [n.id, ...ids(n.children as { id: string; children: unknown[] }[])]);
    expect(ids(data.tree)).toEqual(ids(holder.tree));
    expect(data.totals.period1.netSales).toBe(holder.totals.period1.netSales);
  });
});

describe("Inventory Health follows View cost", () => {
  const input = { pivot: "department" as const };

  it("a holder gets cost value, ordered by it", async () => {
    const data = await reportsAs("mia").inventoryHealth(input);
    expect(data.costVisible).toBe(true);
    expect(data.rows.map((r) => r.key)).toEqual(["Case Goods", "Lighting"]);
    expect("costValue" in data.totals && data.totals.costValue).toBe(1400);
  });

  it("an admin without View cost gets units and retail value, ordered by retail", async () => {
    const holder = await reportsAs("mia").inventoryHealth(input);
    const data = await reportsAs("ada").inventoryHealth(input);
    expect(data.costVisible).toBe(false);
    expect(costKeys(data)).toEqual([]);
    expect(data.rows.map((r) => r.key)).toEqual(["Lighting", "Case Goods"]);
    const pick = (rows: { key: string; units: number; retailValue: number; deadUnits: number }[]) =>
      Object.fromEntries(rows.map((r) => [r.key, [r.units, r.retailValue, r.deadUnits]]));
    expect(pick(data.rows)).toEqual(pick(holder.rows));
  });
});

describe("PO Sell-Through follows View cost", () => {
  const input = { poNumbers: ["PO-MGMT-1"] };

  it("a holder gets margin per frame and overall", async () => {
    const data = await reportsAs("mia").poSellThru(input);
    expect(data.costVisible).toBe(true);
    expect(data.frames.length).toBeGreaterThan(0);
    expect(data.frames[0]).toHaveProperty("marginRatio");
    expect(data.frames[0]).toHaveProperty("totalCost");
    expect(data.rollup).toHaveProperty("overallMargin");
  });

  it("an admin without View cost gets only the public frame fields", async () => {
    const holder = await reportsAs("mia").poSellThru(input);
    const data = await reportsAs("ada").poSellThru(input);
    expect(data.costVisible).toBe(false);
    expect(costKeys(data)).toEqual([]);
    for (const frame of data.frames) {
      expect(Object.keys(frame).sort()).toEqual(
        [...FRAME_PUBLIC_FIELDS, "realizedRetailRatio"].sort(),
      );
    }
    expect(data.frames.map((f) => [f.frameKey, f.qtyOrdered, f.revenue])).toEqual(
      holder.frames.map((f) => [f.frameKey, f.qtyOrdered, f.revenue]),
    );
  });
});

describe("the Buyers Report follows View cost", () => {
  const input = { startDate: "2026-09-01", endDate: "2026-09-30" };
  type Node = { soldQty: number; children: Node[] };
  const leafSold = (nodes: Node[]): number[] =>
    nodes.flatMap((n) => (n.children.length ? leafSold(n.children) : [n.soldQty]));

  it("a holder gets sold cost in the groups and the totals", async () => {
    const data = await reportsAs("mia").buyersSummary(input);
    expect(data.costVisible).toBe(true);
    expect(data.groups[0]).toHaveProperty("soldCost");
    expect(data.totals).toHaveProperty("soldCost");
  });

  it("an admin without View cost gets the same sales with no cost at any depth", async () => {
    const holder = await reportsAs("mia").buyersSummary(input);
    const data = await reportsAs("ada").buyersSummary(input);
    expect(data.costVisible).toBe(false);
    expect(costKeys(data)).toEqual([]);
    expect(data.totals.soldTotal).toBe(holder.totals.soldTotal);
    expect(leafSold(data.groups as Node[])).toEqual(leafSold(holder.groups as Node[]));
  });

  it("viewing as a MANAGER does not give that admin the cost back", async () => {
    const data = await reportsAs("ada", "MANAGER").buyersSummary(input);
    expect(data.costVisible).toBe(false);
    expect(costKeys(data)).toEqual([]);
  });
});

describe("the Open PO Gaps page follows View cost", () => {
  /** What the server page hands its client view, for one viewer. */
  async function pageData(userId: string) {
    (getToken as jest.Mock).mockResolvedValue({ id: userId });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
    const element = await PoGapsPage();
    return element.props.data;
  }

  it("sends PO cost to a holder and the same gaps without it to anyone else", async () => {
    const holder = await pageData("sam");
    expect(holder.costVisible).toBe(true);
    expect(holder.rows[0]).toHaveProperty("totalCost");

    const blind = await pageData("ada");
    expect(blind.costVisible).toBe(false);
    expect(costKeys(blind)).toEqual([]);
    expect(blind.total).toBe(holder.total);
    expect(blind.missingESD).toBe(holder.missingESD);
  });

  it("keeps its gate: a MANAGER is sent away", async () => {
    await expect(pageData("mia")).rejects.toThrow("REDIRECT /app");
  });
});
