// __tests__/integration/queryBuilder.integration.test.ts
//
// Ad-hoc reporting (GAP-34, DECISIONS 53) against a real database through the real route:
// who may use it, what leaves the server, and which rows count in a total. Only the
// session readers are stood in for.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { SUMMARY_MAX_ROWS } from "@/lib/queryBuilderSummary";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import route from "@/pages/api/tools/query-builder";
import QueryBuilderPage from "@/app/(dashboard)/app/tools/query-builder/page";
import ReportsHubPage from "@/app/(dashboard)/app/reports/page";

async function ask(who: string, body: object, method = "POST") {
  const session = { user: { id: who, email: `${who}@example.com` } };
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  let status = 200;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
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
    { method, query: {}, body, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return { status, body: payload };
}

async function makeStaff(who: string, roleKey: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId: who,
      email: `${who}@example.com`,
      displayName: who,
      role: roleKey as never,
      roleId: role.id,
      defaultStore: "Main Street",
    },
  });
}

/** Gives a role a key, or takes one away, as the Roles screen does. */
async function setGrant(roleKey: string, permission: string, held: boolean) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  if (held) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permission } });
  } else {
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permission } });
  }
  await prisma.role.update({ where: { id: role.id }, data: { grantsCustomized: true } });
  invalidateRoleGrantCache();
}

let world: Awaited<ReturnType<typeof makeWorld>>;

async function makeWorld() {
  const vendor = await prisma.vendor.create({ data: { name: "Northfield" } });
  const department = await prisma.department.create({ data: { name: "Living Room" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "S-1",
      name: "Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  return { vendor, department, category, product };
}

let orderCount = 0;

async function makeOrder(
  lines: {
    netPrice: number;
    status?: "ACTIVE" | "CANCELLED" | "BACKORDERED" | "REPLACED";
    quantity?: number;
    vat?: number;
    noProduct?: boolean;
  }[],
  {
    status = "ORDER",
    salesperson = "Sam" as string | null,
    orderDate = new Date("2026-11-15T17:00:00.000Z"),
  }: {
    status?: "QUOTE" | "ORDER" | "FULFILLED" | "RETURNED" | "CANCELLED";
    salesperson?: string | null;
    orderDate?: Date;
  } = {},
) {
  orderCount += 1;
  return prisma.salesOrder.create({
    data: {
      orderno: `SO-${orderCount}`,
      status,
      salesperson,
      storeLocation: "Main Street",
      orderDate,
      lineItems: {
        create: lines.map((line, i) => ({
          lineNumber: i + 1,
          productId: line.noProduct ? null : world.product.id,
          productName: "Sofa",
          orderedQuantity: line.quantity ?? 1,
          netPrice: line.netPrice,
          cost: line.netPrice / 2,
          vatRate: 0,
          vatAmount: line.vat ?? 0,
          lineItemStatus: line.status ?? "ACTIVE",
        })),
      },
    },
  });
}

const totals = (who: string, body: object, entity = "OrderLineItem") =>
  ask(who, { entity, ...body });

const cell = (table: { rows: (string | number)[][] }, label: string, column = 1) =>
  table.rows.find((row) => row[0] === label)?.[column];

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, appName: "Holt", timezone: "America/New_York" },
  });
  invalidateAppSettingsCache();
  await makeStaff("owner", "SUPER_ADMIN");
  await makeStaff("boss", "ADMIN");
  await makeStaff("lead", "MANAGER");
  await makeStaff("till", "REGISTER");
  world = await makeWorld();
});

describe("who may use it", () => {
  it("starts with the owner and administrators", async () => {
    expect((await ask("owner", { entity: "Customer" })).status).toBe(200);
    expect((await ask("boss", { entity: "Customer" })).status).toBe(200);
  });

  it("refuses everyone else by default, managers included", async () => {
    expect((await ask("lead", { entity: "Customer" })).status).toBe(403);
    expect((await ask("till", { entity: "Customer" })).status).toBe(403);
  });

  it("opens to a role the store grants it to", async () => {
    await setGrant("MANAGER", "reporting.adhoc", true);
    expect((await ask("lead", { entity: "Customer" })).status).toBe(200);
  });

  it("closes to a role the store takes it from", async () => {
    await setGrant("ADMIN", "reporting.adhoc", false);
    expect((await ask("boss", { entity: "Customer" })).status).toBe(403);
  });

  it("only answers POST", async () => {
    expect((await ask("boss", { entity: "Customer" }, "GET")).status).toBe(405);
  });
});

describe("what leaves the server", () => {
  it("is only the columns on the list, whatever else the model holds", async () => {
    await prisma.customer.create({
      data: {
        firstName: "Ada",
        lastName: "Lane",
        taxExemptNumber: "TAX-PRIVATE-1",
        email: "a@example.com",
      },
    });
    const res = await ask("boss", { entity: "Customer" });
    expect(res.status).toBe(200);
    expect(res.body.columns.sort()).toEqual(
      ["email", "firstName", "id", "lastName", "phone", "tradeCompanyName"].sort(),
    );
    expect(JSON.stringify(res.body)).not.toContain("TAX-PRIVATE-1");
  });

  it("reads every entity on the list, with every join, against the real schema", async () => {
    const { ENTITIES } = await import("@/lib/queryBuilderConfig");
    for (const entity of ENTITIES) {
      const res = await ask("boss", {
        entity: entity.key,
        joins: entity.joins.map((j) => j.relation),
      });
      expect(`${entity.key} ${res.status}`).toBe(`${entity.key} 200`);
    }
  });

  it("totals every entity by every group and total on the list, against the real schema", async () => {
    const { ENTITIES } = await import("@/lib/queryBuilderConfig");
    const { measuresOf } = await import("@/lib/queryBuilderSummary");
    for (const entity of ENTITIES) {
      for (const group of entity.totals.groups) {
        const res = await totals(
          "boss",
          { summary: { groupBy: group.key, measures: measuresOf(entity).map((m) => m.key) } },
          entity.key,
        );
        expect(`${entity.key} ${group.key} ${res.status}`).toBe(`${entity.key} ${group.key} 200`);
      }
    }
  });

  it("reads a joined Decimal as a number", async () => {
    await makeOrder([{ netPrice: 12.5 }]);
    const res = await ask("boss", { entity: "SalesOrder", joins: ["lineItems"] });
    expect(res.body.rows[0]["lineItems.netPrice"]).toBe(12.5);
    expect(res.body.rows[0]["lineItems._count"]).toBe(1);
  });

  it("caps a list at 500, however many are asked for", async () => {
    const res = await ask("boss", { entity: "Customer", limit: 100000 });
    expect(res.status).toBe(200);
    const spy = jest.spyOn(prisma.customer, "findMany");
    await ask("boss", { entity: "Customer", limit: 100000 });
    expect((spy.mock.calls[0][0] as { take: number }).take).toBe(500);
    spy.mockRestore();
  });

  it("falls back to 100 rows on a limit that isn't one", async () => {
    const spy = jest.spyOn(prisma.customer, "findMany");
    await ask("boss", { entity: "Customer", limit: "lots" });
    expect((spy.mock.calls[0][0] as { take: number }).take).toBe(100);
    spy.mockRestore();
  });
});

describe("cost", () => {
  beforeEach(async () => {
    await setGrant("MANAGER", "reporting.adhoc", true);
    await setGrant("MANAGER", "catalog.cost", false);
    await makeOrder([{ netPrice: 100 }]);
  });

  it("shows to a caller with View cost", async () => {
    const res = await ask("boss", { entity: "OrderLineItem" });
    expect(res.body.columns).toContain("cost");
    expect(res.body.rows[0].cost).toBe(50);
  });

  it("is left out of the rows without it, and the rest still comes", async () => {
    const res = await ask("lead", { entity: "OrderLineItem" });
    expect(res.status).toBe(200);
    expect(res.body.columns).not.toContain("cost");
    expect(res.body.columns).toContain("netPrice");
  });

  it("is left out of a joined relation without it", async () => {
    const res = await ask("lead", { entity: "PurchaseOrder", joins: ["lineItems"] });
    expect(res.status).toBe(200);
    const po = await prisma.purchaseOrder.create({
      data: { poNumber: "PO-1", vendorId: world.vendor.id },
    });
    await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: world.product.id,
        unitCost: 77,
        orderedQuantity: 1,
      },
    });
    const seen = await ask("lead", { entity: "PurchaseOrder", joins: ["lineItems"] });
    expect(JSON.stringify(seen.body)).not.toContain("77");
    expect(seen.body.columns).not.toContain("lineItems.unitCost");
  });

  it("can't be totalled without it", async () => {
    const res = await totals("lead", { summary: { groupBy: "store", measures: ["cost"] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown total");
  });

  it("can be totalled with it", async () => {
    const res = await totals("boss", { summary: { groupBy: "store", measures: ["cost"] } });
    expect(res.body.table.footer).toEqual(["Total", 50]);
  });
});

describe("which lines count in a total", () => {
  const net = async () => {
    const res = await totals("boss", {
      summary: { groupBy: "store", measures: ["count", "netPrice"] },
    });
    expect(res.status).toBe(200);
    return res.body.table;
  };

  it("leaves out cancelled and replaced lines, and counts a backordered one", async () => {
    await makeOrder([
      { netPrice: 100 },
      { netPrice: 40, status: "BACKORDERED" },
      { netPrice: 1000, status: "CANCELLED" },
      { netPrice: 2000, status: "REPLACED" },
    ]);
    expect((await net()).footer).toEqual(["Total", 2, 140]);
  });

  it("leaves out a zero-quantity line", async () => {
    await makeOrder([{ netPrice: 100 }, { netPrice: 500, quantity: 0 }]);
    expect((await net()).footer).toEqual(["Total", 1, 100]);
  });

  it("leaves out quotes and cancelled orders", async () => {
    await makeOrder([{ netPrice: 100 }]);
    await makeOrder([{ netPrice: 1000 }], { status: "QUOTE" });
    await makeOrder([{ netPrice: 2000 }], { status: "CANCELLED" });
    expect((await net()).footer).toEqual(["Total", 1, 100]);
  });

  it("keeps fulfilled and returned orders, so a return nets out", async () => {
    await makeOrder([{ netPrice: 300 }], { status: "FULFILLED" });
    await makeOrder([{ netPrice: -100, quantity: -1 }], { status: "RETURNED" });
    expect((await net()).footer).toEqual(["Total", 2, 200]);
  });

  it("says so beside the total", async () => {
    expect((await net()).population).toContain("cancelled and replaced lines");
  });

  it("still lists a cancelled line as a row, since rows show what's there", async () => {
    await makeOrder([{ netPrice: 1000, status: "CANCELLED" }]);
    const res = await ask("boss", { entity: "OrderLineItem" });
    expect(res.body.rowCount).toBe(1);
  });

  it("counts a line with no salesperson under its own group (rule 51)", async () => {
    await makeOrder([{ netPrice: 100 }], { salesperson: null });
    await makeOrder([{ netPrice: 50 }]);
    const res = await totals("boss", {
      summary: { groupBy: "salesperson", measures: ["netPrice"] },
    });
    expect(res.body.table.rows).toEqual([
      ["Sam", 50],
      ["(none)", 100],
    ]);
  });

  it("counts a line with no product under its own vendor group, through two relations", async () => {
    await makeOrder([{ netPrice: 100 }, { netPrice: 25, noProduct: true }]);
    const res = await totals("boss", { summary: { groupBy: "vendor", measures: ["netPrice"] } });
    expect(res.body.table.rows).toEqual([
      ["Northfield", 100],
      ["(none)", 25],
    ]);
  });

  it("adds a line's tax, which can be empty", async () => {
    await makeOrder([{ netPrice: 100, vat: 7 }, { netPrice: 100 }]);
    await prisma.orderLineItem.updateMany({ where: { vatAmount: 0 }, data: { vatAmount: null } });
    const res = await totals("boss", { summary: { groupBy: "store", measures: ["tax"] } });
    expect(res.body.table.footer).toEqual(["Total", 7]);
  });
});

describe("which rows count for the other entities", () => {
  it("leaves cancelled orders out of an order count, and keeps quotes under their status", async () => {
    await makeOrder([{ netPrice: 1 }]);
    await makeOrder([{ netPrice: 1 }], { status: "QUOTE" });
    await makeOrder([{ netPrice: 1 }], { status: "CANCELLED" });
    const res = await totals(
      "boss",
      { summary: { groupBy: "status", measures: ["count"] } },
      "SalesOrder",
    );
    expect(res.body.table.rows).toEqual([
      ["ORDER", 1],
      ["QUOTE", 1],
    ]);
  });

  it("leaves cancelled POs and zero quantities out of PO lines, and works out cost", async () => {
    const po = await prisma.purchaseOrder.create({
      data: { poNumber: "PO-1", vendorId: world.vendor.id, status: "SUBMITTED" },
    });
    const dead = await prisma.purchaseOrder.create({
      data: { poNumber: "PO-2", vendorId: world.vendor.id, status: "CANCELLED" },
    });
    const line = (purchaseOrderId: number, orderedQuantity: number, unitCost: number) =>
      prisma.purchaseOrderItem.create({
        data: { purchaseOrderId, productId: world.product.id, orderedQuantity, unitCost },
      });
    await line(po.id, 3, 10.5);
    await line(po.id, 0, 999);
    await line(dead.id, 5, 999);
    const res = await totals(
      "boss",
      { summary: { groupBy: "vendor", measures: ["quantity", "cost"] } },
      "PurchaseOrderItem",
    );
    expect(res.body.table.rows).toEqual([["Northfield", 3, 31.5]]);
  });

  it("totals service cases by status, open or closed", async () => {
    const type = await prisma.serviceCaseType.create({ data: { name: "Repair" } });
    const open = await prisma.serviceCaseStatus.create({ data: { name: "Open" } });
    const closed = await prisma.serviceCaseStatus.create({
      data: { name: "Closed", isClosed: true },
    });
    const priority = await prisma.serviceCasePriority.create({ data: { name: "Normal" } });
    const make = (caseNumber: string, statusId: number) =>
      prisma.serviceCase.create({
        data: {
          caseNumber,
          summary: "Leg broke",
          typeId: type.id,
          statusId,
          priorityId: priority.id,
        },
      });
    await make("C-1", open.id);
    await make("C-2", open.id);
    await make("C-3", closed.id);
    const res = await totals(
      "boss",
      { summary: { groupBy: "status", measures: ["count"] } },
      "ServiceCase",
    );
    expect(res.body.table.rows).toEqual([
      ["Closed", 1],
      ["Open", 2],
    ]);
    const filtered = await ask("boss", {
      entity: "ServiceCase",
      joins: ["status"],
      filters: [{ field: "status.name", op: "contains", value: "clos" }],
    });
    expect(filtered.body.rows.map((r: { caseNumber: string }) => r.caseNumber)).toEqual(["C-3"]);
    expect(filtered.body.rows[0]["status.name"]).toBe("Closed");
  });

  it("leaves cancelled transfers out, and totals their quantity by destination", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const move = (toLocation: string, quantity: number, status: "DRAFT" | "CANCELLED") =>
      prisma.inventoryTransfer.create({
        data: {
          productId: world.product.id,
          quantity,
          fromLocation: "Main Street",
          toLocation,
          status,
          requestedByUserId: user.id,
        },
      });
    await move("Harbor", 2.5, "DRAFT");
    await move("Harbor", 1, "DRAFT");
    await move("Harbor", 99, "CANCELLED");
    const res = await totals(
      "boss",
      { summary: { groupBy: "to", measures: ["count", "quantity"] } },
      "InventoryTransfer",
    );
    expect(res.body.table.rows).toEqual([["Harbor", 2, 3.5]]);
  });
});

describe("filters", () => {
  it("applies both ends of a date range to a total, in the store's time", async () => {
    // 11:30pm Eastern on Oct 31, and 12:30am Eastern on Nov 1.
    await makeOrder([{ netPrice: 1 }], { orderDate: new Date("2026-11-01T03:30:00.000Z") });
    await makeOrder([{ netPrice: 10 }], { orderDate: new Date("2026-11-01T04:30:00.000Z") });
    await makeOrder([{ netPrice: 100 }], { orderDate: new Date("2026-11-30T23:00:00.000Z") });
    await makeOrder([{ netPrice: 1000 }], { orderDate: new Date("2026-12-01T06:00:00.000Z") });
    const res = await totals("boss", {
      filters: [
        { field: "salesOrder.orderDate", op: "gte", value: "2026-11-01" },
        { field: "salesOrder.orderDate", op: "lte", value: "2026-11-30" },
      ],
      summary: { groupBy: "orderMonth", measures: ["netPrice"] },
    });
    expect(res.body.table.rows).toEqual([["2026-11", 110]]);
  });

  it("files months across a pivot by the store's time", async () => {
    await makeOrder([{ netPrice: 1 }], { orderDate: new Date("2026-11-01T03:30:00.000Z") });
    await makeOrder([{ netPrice: 10 }], { orderDate: new Date("2026-11-01T04:30:00.000Z") });
    const res = await totals("boss", {
      summary: { groupBy: "salesperson", across: "orderMonth", measures: ["netPrice"] },
    });
    expect(res.body.table.columns.map((c: { label: string }) => c.label)).toEqual([
      "Salesperson",
      "2026-10",
      "2026-11",
      "Total",
    ]);
    expect(cell(res.body.table, "Sam", 1)).toBe(1);
    expect(cell(res.body.table, "Sam", 2)).toBe(10);
    expect(cell(res.body.table, "Sam", 3)).toBe(11);
  });

  it("keeps NULL rows on not-equal, in a list and a total", async () => {
    await makeOrder([{ netPrice: 100 }], { salesperson: null });
    await makeOrder([{ netPrice: 10 }], { salesperson: "Sam" });
    await makeOrder([{ netPrice: 1 }], { salesperson: "Ann" });
    const filters = [{ field: "salesOrder.salesperson", op: "not", value: "Sam" }];
    const res = await totals("boss", {
      filters,
      summary: { groupBy: "store", measures: ["netPrice"] },
    });
    expect(res.body.table.footer).toEqual(["Total", 101]);
    const listed = await ask("boss", {
      entity: "SalesOrder",
      filters: [{ field: "salesperson", op: "not", value: "Sam" }],
    });
    expect(listed.body.rowCount).toBe(2);
  });

  it("finds an order number made of digits, instead of failing", async () => {
    await prisma.salesOrder.create({ data: { orderno: "12345", status: "ORDER" } });
    const res = await ask("boss", {
      entity: "SalesOrder",
      filters: [{ field: "orderno", op: "equals", value: "12345" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.rowCount).toBe(1);
  });

  it("answers 400, naming the problem, on a filter it doesn't offer", async () => {
    const res = await ask("boss", {
      entity: "Customer",
      filters: [{ field: "taxExemptNumber", op: "contains", value: "x" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown filter field");
  });
});

describe("more rows than it can total", () => {
  it("refuses and says how to narrow it, rather than total part of them", async () => {
    const spy = jest
      .spyOn(prisma.orderLineItem, "findMany")
      .mockResolvedValue(new Array(SUMMARY_MAX_ROWS + 1).fill({}) as never);
    const res = await totals("boss", { summary: { groupBy: "store", measures: ["count"] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Narrow it with a filter");
    expect((spy.mock.calls[0][0] as { take: number }).take).toBe(SUMMARY_MAX_ROWS + 1);
    spy.mockRestore();
  });

  it("totals exactly as many as it can", async () => {
    const spy = jest
      .spyOn(prisma.orderLineItem, "findMany")
      .mockResolvedValue(new Array(SUMMARY_MAX_ROWS).fill({}) as never);
    const res = await totals("boss", { summary: { groupBy: "store", measures: ["count"] } });
    expect(res.status).toBe(200);
    expect(res.body.table.footer).toEqual(["Total", SUMMARY_MAX_ROWS]);
    spy.mockRestore();
  });
});

describe("exporting", () => {
  const exported = () =>
    prisma.auditEntry.findMany({ where: { event: "DATA_EXPORTED" }, orderBy: { id: "asc" } });

  it("goes in the audit trail, with what and how many, for rows and totals", async () => {
    await prisma.customer.create({ data: { firstName: "Ada", email: "ada@example.com" } });
    const rows = await ask("boss", {
      entity: "Customer",
      export: true,
      filters: [{ field: "email", op: "contains", value: "ada@" }],
    });
    expect(rows.status).toBe(200);
    await makeOrder([{ netPrice: 1 }]);
    const summed = await totals("boss", {
      export: true,
      summary: { groupBy: "store", measures: ["count"] },
    });
    expect(summed.status).toBe(200);

    const entries = await exported();
    expect(entries.map((e) => [e.actor, e.summary])).toEqual([
      ["boss@example.com", "Customers exported from the query builder: 1 rows"],
      ["boss@example.com", "Order Line Items exported from the query builder: 1 rows"],
    ]);
    // What was searched for isn't recorded: it can be a customer's address.
    expect(JSON.stringify(entries)).not.toContain("ada@");
  });

  it("doesn't record just looking", async () => {
    await ask("boss", { entity: "Customer" });
    expect(await exported()).toEqual([]);
  });

  it("needs Export data, even for someone who can run the report", async () => {
    await setGrant("MANAGER", "reporting.adhoc", true);
    await setGrant("MANAGER", "reporting.export", false);
    expect((await ask("lead", { entity: "Customer" })).status).toBe(200);
    const res = await ask("lead", { entity: "Customer", export: true });
    expect(res.status).toBe(403);
    expect(await exported()).toEqual([]);
  });
});

describe("the screens", () => {
  function signIn(who: string) {
    (getToken as jest.Mock).mockResolvedValue({ id: who });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ get: () => undefined, getAll: () => [] });
    const session = { user: { id: who, email: `${who}@example.com` } };
    (getServerSession as jest.Mock).mockResolvedValue(session);
    (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  }
  const hasCard = async () => {
    const hub = await ReportsHubPage();
    return hub.props.items.some(
      (item: { href: string }) => item.href === "/app/tools/query-builder",
    );
  };

  it("gives an admin the report builder, with cost and export", async () => {
    signIn("boss");
    const page = await QueryBuilderPage();
    expect(page.props).toEqual({ canSeeCost: true, canExport: true });
    expect(await hasCard()).toBe(true);
  });

  it("sends a manager away, with no card, until the store grants the key", async () => {
    signIn("lead");
    await expect(QueryBuilderPage()).rejects.toThrow(/REDIRECT/);
    expect(await hasCard()).toBe(false);

    await setGrant("MANAGER", "reporting.adhoc", true);
    await expect(QueryBuilderPage()).resolves.toBeDefined();
    expect(await hasCard()).toBe(true);
  });

  it("tells the screen what a granted role can't do, so it doesn't offer it", async () => {
    await setGrant("MANAGER", "reporting.adhoc", true);
    await setGrant("MANAGER", "catalog.cost", false);
    await setGrant("MANAGER", "reporting.export", false);
    signIn("lead");
    const page = await QueryBuilderPage();
    expect(page.props).toEqual({ canSeeCost: false, canExport: false });
  });
});

describe("a failed query", () => {
  it("says only that it failed, with no database detail", async () => {
    jest.spyOn(prisma.customer, "findMany").mockRejectedValueOnce(new Error('column "x" secret'));
    const res = await ask("boss", { entity: "Customer" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Query failed" });
  });
});
