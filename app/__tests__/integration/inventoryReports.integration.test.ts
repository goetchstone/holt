// /app/__tests__/integration/inventoryReports.integration.test.ts
//
// GAP-17 against real Postgres: Aged Stock and Inventory Value read back from the
// stock journal, the Transfers report's populations, and the counting schedule.
// Each report goes through the real router and its gate, with stock put in place
// by the ledger, so jest.integration.afterEach.ts's drift check holds throughout.

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

import type { InventoryTransferStatus } from "@prisma/client";
import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { postCount, submitCount, cancelCount } from "@/lib/inventory/count";
import { COUNT_EVERY_DAYS_MAX } from "@/lib/inventory/countSchedule";
import { postBackdatedMovement, postMovement, type Place } from "@/lib/inventory/ledger";
import { getInventoryHealth } from "@/lib/reports/inventoryHealth";
import { AGED_PRODUCT_LIMIT, getAgedStock } from "@/lib/reports/agedStock";
import { TRANSFER_ROW_LIMIT } from "@/lib/reports/transfersReport";
import { getInventoryValue } from "@/lib/reports/inventoryValue";
import { addDays, businessDayKey, businessHourStart, daysBetween } from "@/lib/reports/businessDay";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handler as countsHandler } from "@/pages/api/inventory/counts";
import { handler as placeHandler } from "@/pages/api/warehouse/stock-locations/[id]";
import { handler as storePlacesHandler } from "@/pages/api/warehouse/locations/[id]/stock-locations";
import locationsHandler from "@/pages/api/warehouse/locations";
import AgedStockPage from "@/app/(dashboard)/app/reports/aged-stock/page";
import InventoryValuePage from "@/app/(dashboard)/app/reports/inventory-value/page";
import TransfersReportPage from "@/app/(dashboard)/app/reports/transfers/page";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function reportsAs(userId: string) {
  const ctx: TrpcContext = {
    userId,
    userEmail: `${userId}@example.com`,
    tokenRole: null,
    impersonate: null,
    headers: new Headers(),
  };
  return createCallerFactory(appRouter)(ctx).reports;
}

/** What these routes answer with, as far as the tests read it. */
interface RouteBody {
  error: string;
  schedule: {
    place: string;
    standing: string;
    lastCountedOn: string | null;
    dueOn: string | null;
    daysLate: number;
    store: string;
  }[];
  countEveryDays: number | null;
  locations: { stockLocations: { code: string; countEveryDays: number | null }[] }[];
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown as RouteBody,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload as RouteBody;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: RouteBody };
}

const session = { user: { email: "mia@example.com", role: "MANAGER" } } as unknown as Session;

async function callRoute(
  handler: (req: NextApiRequest, res: NextApiResponse, s: Session) => Promise<unknown>,
  method: string,
  query: Record<string, string>,
  body?: unknown,
) {
  const res = makeRes();
  await handler({ method, query, body } as unknown as NextApiRequest, res, session);
  return res;
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

/** Sign the server pages in as this staff member. */
function signInToPages(userId: string) {
  (getToken as jest.Mock).mockResolvedValue({ id: userId });
  (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  (headers as jest.Mock).mockResolvedValue(new Headers());
}

let timeZone: string;
let today: string;
let mill: { id: number };
let dock: { id: number };
let millBack: Place;
let millFloor: Place;
let dockBack: Place;
let sofa: { id: number };
let lamp: { id: number };

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });
  timeZone = await getBusinessTimeZone();
  today = businessDayKey(new Date(), timeZone);

  // A MANAGER as shipped, an ADMIN whose View cost the owner has unticked, a
  // DESIGNER, and a role with no reports at all.
  await makeStaff("mia", "MANAGER");
  await makeStaff("ada", "ADMIN");
  await makeStaff("dana", "DESIGNER");
  await makeStaff("ian", "INSTALLER");
  const admin = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.rolePermission.deleteMany({
    where: { roleId: admin.id, permission: "catalog.cost" },
  });
  await prisma.role.update({ where: { id: admin.id }, data: { grantsCustomized: true } });
  invalidateRoleGrantCache();

  const vendor = await prisma.vendor.create({ data: { name: "Heron", pricingModel: "FLAT" } });
  const seating = await prisma.department.create({ data: { name: "Seating" } });
  const lighting = await prisma.department.create({ data: { name: "Lighting" } });
  const product = async (
    productNumber: string,
    departmentId: number,
    baseCost: number,
    baseRetail: number,
  ) => {
    const category = await prisma.category.create({
      data: { name: `${productNumber} cat`, departmentId, trackInventory: true },
    });
    return prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        vendorId: vendor.id,
        departmentId,
        categoryId: category.id,
        baseCost,
        baseRetail,
      },
    });
  };
  // Cost order (Seating first) is the reverse of retail order for the two
  // departments once stocked below: a low-cost, high-retail lamp.
  sofa = await product("SOFA", seating.id, 100, 200);
  lamp = await product("LAMP", lighting.id, 10, 500);

  const store = async (code: string) => {
    const s = await prisma.storeLocation.create({ data: { name: code, code, type: "STORE" } });
    const place = async (placeCode: string, locationType: string) =>
      prisma.stockLocation.create({
        data: { storeLocationId: s.id, code: placeCode, name: placeCode, locationType },
      });
    return {
      s,
      back: await place(`${code}-BACK`, "STOCK"),
      floor: await place(`${code}-FLOOR`, "FLOOR"),
    };
  };
  const a = await store("MILL");
  const b = await store("DOCK");
  mill = a.s;
  dock = b.s;
  const placeOf = (storeLocationId: number, stockLocationId: number): Place => ({
    storeLocationId,
    stockLocationId,
    salesOrderId: null,
  });
  millBack = placeOf(a.s.id, a.back.id);
  millFloor = placeOf(a.s.id, a.floor.id);
  dockBack = placeOf(b.s.id, b.back.id);
});

function arrive(
  productId: number,
  quantity: number,
  days: number,
  reason: "RECEIVE" | "OPENING" | "RETURN" | "IMPORT_SYNC" | "ADJUST" = "RECEIVE",
  to: Place = millBack,
) {
  return postBackdatedMovement(prisma, { productId, quantity, to, reason }, daysAgo(days));
}

let orders = 0;
function saleOrder(lineItems?: { create: Record<string, unknown>[] }) {
  orders += 1;
  return prisma.salesOrder.create({
    data: {
      orderno: `SO-${orders}`,
      status: "ORDER",
      orderDate: new Date(),
      storeLocation: "MILL",
      storeLocationId: mill.id,
      ...(lineItems ? { lineItems } : {}),
    } as never,
  });
}

/** Units per bucket, for a holder's whole-report totals. */
const unitsByBucket = (result: { totals: { buckets: { units: number }[] } }) =>
  result.totals.buckets.map((b) => b.units);

describe("Aged Stock: how old a unit is", () => {
  it("counts from receipt, not from the last sale", async () => {
    await arrive(sofa.id, 2, 200);
    // Sold yesterday: Inventory Health calls this product alive, and it's still old.
    await saleOrder({
      create: [{ lineNumber: 1, productId: sofa.id, orderedQuantity: 1, netPrice: 200, cost: 100 }],
    });
    const aged = await getAgedStock(prisma, {});
    expect(unitsByBucket(aged)).toEqual([0, 0, 2, 0]);
    const health = await getInventoryHealth(prisma, { staleDays: 180 });
    expect(health.totals.deadUnits).toBe(0);
  });

  it("puts each age in its own bucket, at the edges", async () => {
    await arrive(sofa.id, 1, 89);
    await arrive(sofa.id, 2, 120);
    await arrive(lamp.id, 4, 300);
    await arrive(lamp.id, 8, 400);
    // Only the newest arrivals count: nothing has left, so all of them are here.
    expect(unitsByBucket(await getAgedStock(prisma, {}))).toEqual([1, 2, 4, 8]);
  });

  it("assumes the oldest sold first: what's left is the newest in", async () => {
    await arrive(sofa.id, 5, 400);
    await arrive(sofa.id, 3, 10);
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 4,
      from: millBack,
      reason: "WRITE_OFF",
    });
    // 4 left, 3 from the recent receipt and 1 from the old one.
    expect(unitsByBucket(await getAgedStock(prisma, {}))).toEqual([3, 0, 0, 1]);
  });

  it("doesn't restart the clock when stock moves between places", async () => {
    await arrive(sofa.id, 2, 200);
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 2,
      from: millBack,
      to: millFloor,
      reason: "TRANSFER",
    });
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 1,
      from: millFloor,
      to: dockBack,
      reason: "TRANSFER",
    });
    expect(unitsByBucket(await getAgedStock(prisma, {}))).toEqual([0, 0, 2, 0]);
  });

  it("restarts it when a customer brings the unit back", async () => {
    await arrive(sofa.id, 1, 400);
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 1,
      from: millBack,
      reason: "DELIVER",
    });
    await arrive(sofa.id, 1, 5, "RETURN");
    const aged = await getAgedStock(prisma, {});
    expect(unitsByBucket(aged)).toEqual([1, 0, 0, 0]);
    expect(aged.oldest[0]).toMatchObject({ arrival: "Returned", atLeast: false, oldestDays: 5 });
  });

  it("keeps it when a delivery is undone: the units never really left", async () => {
    await arrive(sofa.id, 1, 400);
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 1,
      from: millBack,
      reason: "DELIVER",
    });
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 1,
      to: millBack,
      reason: "UNDELIVER",
    });
    expect(unitsByBucket(await getAgedStock(prisma, {}))).toEqual([0, 0, 0, 1]);
  });

  it("a receipt taken back cancels the receipt, so old stock doesn't look new", async () => {
    await arrive(sofa.id, 3, 300);
    await arrive(sofa.id, 5, 2);
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 5,
      from: millBack,
      reason: "UNRECEIVE",
    });
    expect(unitsByBucket(await getAgedStock(prisma, {}))).toEqual([0, 0, 3, 0]);
  });

  it("a count that took stock away isn't an arrival, and neither is a correction between places", async () => {
    await arrive(sofa.id, 3, 200);
    await arrive(sofa.id, 2, 100, "ADJUST");
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 2,
      from: millBack,
      reason: "ADJUST",
    });
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 1,
      from: millBack,
      to: millFloor,
      reason: "ADJUST",
    });
    expect(unitsByBucket(await getAgedStock(prisma, {}))).toEqual([0, 2, 1, 0]);
  });

  it("says when a date is only when Holt first heard of the stock", async () => {
    await arrive(sofa.id, 2, 30, "OPENING");
    await arrive(lamp.id, 3, 30, "IMPORT_SYNC");
    await arrive(lamp.id, 1, 3, "ADJUST");
    const aged = await getAgedStock(prisma, {});
    expect(aged.totals.atLeastUnits).toBe(5);
    const bySku = Object.fromEntries(aged.oldest.map((p) => [p.name, p]));
    expect(bySku.SOFA).toMatchObject({ arrival: "Opening balance", atLeast: true });
    expect(bySku.LAMP).toMatchObject({ arrival: "Imported", atLeast: true });
  });

  it("calls a count that found more what it is", async () => {
    await arrive(sofa.id, 1, 3, "ADJUST");
    const aged = await getAgedStock(prisma, {});
    expect(aged.oldest[0]).toMatchObject({ arrival: "Found in a count", atLeast: false });
    expect(aged.totals.atLeastUnits).toBe(0);
  });

  it("doesn't guess at units no arrival accounts for", async () => {
    // An arrival a transfer made before transit places existed: into the books,
    // from nowhere the journal can date.
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 2,
      to: millBack,
      reason: "TRANSFER",
    });
    await arrive(sofa.id, 1, 5);
    const aged = await getAgedStock(prisma, {});
    expect(aged.totals.units).toBe(3);
    expect(aged.totals.noRecordUnits).toBe(2);
    expect(unitsByBucket(aged)).toEqual([1, 0, 0, 0]);
  });
});

describe("Aged Stock: which stock", () => {
  it("leaves committed stock out, and says how much", async () => {
    const order = await saleOrder();
    const staging = await prisma.stockLocation.create({
      data: {
        storeLocationId: mill.id,
        code: "HOLD",
        name: "Hold",
        locationType: "STOCK",
        holdsCommittedStock: true,
      },
    });
    await arrive(sofa.id, 2, 200);
    await arrive(sofa.id, 3, 200, "RECEIVE", { ...millBack, salesOrderId: order.id });
    await arrive(sofa.id, 4, 200, "RECEIVE", {
      storeLocationId: mill.id,
      stockLocationId: staging.id,
      salesOrderId: null,
    });
    const aged = await getAgedStock(prisma, {});
    expect(aged.totals.units).toBe(2);
    expect(aged.committedUnits).toBe(7);
  });

  it("keeps stock that isn't for sale but is still old: a display, quarantine", async () => {
    const place = (code: string, locationType: string) =>
      prisma.stockLocation.create({
        data: { storeLocationId: mill.id, code, name: code, locationType },
      });
    const display = await place("DISP", "DISPLAY");
    const quarantine = await place("QUAR", "QUARANTINE");
    const at = (stockLocationId: number): Place => ({
      storeLocationId: mill.id,
      stockLocationId,
      salesOrderId: null,
    });
    await arrive(sofa.id, 1, 400, "RECEIVE", at(display.id));
    await arrive(lamp.id, 1, 200, "RECEIVE", at(quarantine.id));
    expect(unitsByBucket(await getAgedStock(prisma, {}))).toEqual([0, 0, 1, 1]);
  });

  it("adds up with committed units to Inventory Health's units on hand", async () => {
    const order = await saleOrder();
    await arrive(sofa.id, 5, 200);
    await arrive(lamp.id, 7, 20, "OPENING", dockBack);
    await arrive(lamp.id, 2, 20, "RECEIVE", { ...millBack, salesOrderId: order.id });
    const aged = await getAgedStock(prisma, {});
    const health = await getInventoryHealth(prisma, {});
    expect(aged.totals.units + aged.committedUnits).toBe(health.totals.units);
  });

  it("every unit is in a bucket or reported as having no record", async () => {
    await arrive(sofa.id, 5, 30);
    await arrive(sofa.id, 5, 200);
    await postMovement(prisma, {
      productId: lamp.id,
      quantity: 1,
      to: millBack,
      reason: "TRANSFER",
    });
    const { totals, rows } = await getAgedStock(prisma, {});
    const sum = (b: { units: number }[]) => b.reduce((s, x) => s + x.units, 0);
    expect(sum(totals.buckets) + totals.noRecordUnits).toBe(totals.units);
    for (const r of rows) expect(sum(r.buckets) + r.noRecordUnits).toBe(r.units);
  });

  it("values each bucket at cost and at retail, and flags stock with no cost", async () => {
    const free = await prisma.product.update({
      where: { id: lamp.id },
      data: { baseCost: null },
    });
    await arrive(free.id, 3, 10);
    await arrive(sofa.id, 2, 200);
    const { totals } = await getAgedStock(prisma, {});
    expect(totals.buckets[0]).toEqual({ units: 3, costValue: 0, retailValue: 1500 });
    expect(totals.buckets[2]).toEqual({ units: 2, costValue: 200, retailValue: 400 });
    expect(totals).toMatchObject({ costValue: 200, retailValue: 1900, uncostedUnits: 3 });
  });

  it("uses landed cost when a product has one, as Inventory Health does", async () => {
    await prisma.product.update({ where: { id: sofa.id }, data: { landedCost: 130 } });
    await arrive(sofa.id, 2, 10);
    expect((await getAgedStock(prisma, {})).totals.costValue).toBe(260);
  });

  it("groups by vendor when asked, and lists the oldest first", async () => {
    await arrive(sofa.id, 2, 10);
    await arrive(lamp.id, 1, 300);
    const aged = await getAgedStock(prisma, { pivot: "vendor" });
    expect(aged.rows.map((r) => r.key)).toEqual(["Heron"]);
    expect(aged.oldest.map((p) => p.name)).toEqual(["LAMP", "SOFA"]);
    expect(aged.productCount).toBe(2);
    expect(aged.oldest.length).toBeLessThanOrEqual(AGED_PRODUCT_LIMIT);
  });

  it("lists by age, not by name, then by how many", async () => {
    await arrive(sofa.id, 1, 300);
    await arrive(lamp.id, 1, 10);
    expect((await getAgedStock(prisma, {})).oldest.map((p) => p.name)).toEqual(["SOFA", "LAMP"]);
  });

  it("leaves out a product whose stock is all committed", async () => {
    const order = await saleOrder();
    await arrive(sofa.id, 2, 10, "RECEIVE", { ...millBack, salesOrderId: order.id });
    const aged = await getAgedStock(prisma, {});
    expect(aged.committedUnits).toBe(2);
    expect(aged.rows).toEqual([]);
    expect(aged.productCount).toBe(0);
    expect(aged.oldest).toEqual([]);
  });

  it("is empty, not an error, with nothing on the books", async () => {
    const aged = await getAgedStock(prisma, {});
    expect(aged.rows).toEqual([]);
    expect(aged.totals.units).toBe(0);
    expect(aged.committedUnits).toBe(0);
  });
});

describe("Aged Stock follows its gate and View cost", () => {
  beforeEach(async () => {
    await arrive(sofa.id, 2, 200);
    await arrive(lamp.id, 1, 10);
  });

  it("a holder gets cost, in cost order", async () => {
    const data = await reportsAs("mia").agedStock({ pivot: "department" });
    expect(data.costVisible).toBe(true);
    expect(data.rows.map((r) => r.key)).toEqual(["Seating", "Lighting"]);
    expect("costValue" in data.totals && data.totals.costValue).toBe(210);
  });

  it("an admin without View cost gets no cost anywhere, in retail order", async () => {
    const data = await reportsAs("ada").agedStock({ pivot: "department" });
    expect(data.costVisible).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/costValue|uncostedUnits/);
    expect(data.rows.map((r) => r.key)).toEqual(["Lighting", "Seating"]);
    expect(data.totals.retailValue).toBe(900);
  });

  it("a designer isn't let in, by the router or the page", async () => {
    await expect(reportsAs("dana").agedStock({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    signInToPages("dana");
    await expect(AgedStockPage()).rejects.toThrow(/REDIRECT/);
  });

  it("the page opens for a manager", async () => {
    signInToPages("mia");
    const page = await AgedStockPage();
    expect(page.type).toBeDefined();
  });
});

describe("Inventory Value: what was on the books", () => {
  it("reads a past day back from the journal", async () => {
    await arrive(sofa.id, 5, 100);
    await postBackdatedMovement(
      prisma,
      { productId: sofa.id, quantity: 2, from: millBack, reason: "DELIVER" },
      daysAgo(50),
    );
    await arrive(lamp.id, 3, 10);
    const on = (n: number) => getInventoryValue(prisma, { asOf: addDays(today, -n) });
    expect((await on(120)).beforeJournal).toBe(true);
    expect((await on(80)).totals).toMatchObject({ units: 5, costValue: 500, retailValue: 1000 });
    expect((await on(30)).totals).toMatchObject({ units: 3, costValue: 300 });
    expect((await on(0)).totals).toMatchObject({ units: 6, costValue: 330 });
  });

  it("as of today is Inventory Health's value, whatever the stock's state", async () => {
    const order = await saleOrder();
    const transit = await prisma.stockLocation.create({
      data: { storeLocationId: mill.id, code: "T", name: "T", locationType: "TRANSIT" },
    });
    const quarantine = await prisma.stockLocation.create({
      data: { storeLocationId: dock.id, code: "Q", name: "Q", locationType: "QUARANTINE" },
    });
    await prisma.product.update({ where: { id: sofa.id }, data: { landedCost: 130 } });
    await arrive(sofa.id, 5, 100);
    await arrive(sofa.id, 2, 90, "RECEIVE", { ...millBack, salesOrderId: order.id });
    await arrive(lamp.id, 3, 90, "OPENING", dockBack);
    await arrive(lamp.id, 1, 30, "RETURN", {
      storeLocationId: dock.id,
      stockLocationId: quarantine.id,
      salesOrderId: null,
    });
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 2,
      from: millBack,
      to: { storeLocationId: mill.id, stockLocationId: transit.id, salesOrderId: null },
      reason: "TRANSFER",
    });
    await postMovement(prisma, {
      productId: sofa.id,
      quantity: 1,
      from: millBack,
      reason: "DELIVER",
    });
    const value = await getInventoryValue(prisma, {});
    const health = await getInventoryHealth(prisma, {});
    expect(value.isToday).toBe(true);
    expect(value.totals.units).toBe(health.totals.units);
    expect(value.totals.costValue).toBe(health.totals.costValue);
    expect(value.totals.retailValue).toBe(health.totals.retailValue);
    // 6 sofas at landed cost, 4 lamps at catalog cost.
    expect(value.totals.costValue).toBe(820);
    expect(value.rows.map((r) => [r.key, r.units, r.costValue])).toEqual(
      health.rows.map((r) => [r.key, r.units, r.costValue]),
    );
  });

  it("ends the day where the store's day ends, not where UTC's does", async () => {
    const day = addDays(today, -10);
    await arrive(sofa.id, 1, 20);
    await postBackdatedMovement(
      prisma,
      { productId: sofa.id, quantity: 2, to: millBack, reason: "RECEIVE" },
      businessHourStart(day, 23, timeZone),
    );
    await postBackdatedMovement(
      prisma,
      { productId: sofa.id, quantity: 4, to: millBack, reason: "RECEIVE" },
      businessHourStart(addDays(day, 1), 0, timeZone),
    );
    expect((await getInventoryValue(prisma, { asOf: day })).totals.units).toBe(3);
    expect((await getInventoryValue(prisma, { asOf: addDays(day, 1) })).totals.units).toBe(7);
  });

  it("follows a store's own stock, and a move between stores", async () => {
    await arrive(sofa.id, 3, 100);
    await postBackdatedMovement(
      prisma,
      { productId: sofa.id, quantity: 1, from: millBack, to: dockBack, reason: "TRANSFER" },
      daysAgo(50),
    );
    const at = (asOf: string, storeLocationId: number) =>
      getInventoryValue(prisma, { asOf, storeLocationId });
    expect((await at(addDays(today, -80), mill.id)).totals.units).toBe(3);
    expect((await at(addDays(today, -80), dock.id)).totals.units).toBe(0);
    expect((await at(today, mill.id)).totals.units).toBe(2);
    expect((await at(today, dock.id)).totals.units).toBe(1);
    expect((await getInventoryValue(prisma, { asOf: today })).totals.units).toBe(3);
  });

  it("drops a group whose stock has all gone, rather than showing it at zero", async () => {
    await arrive(sofa.id, 1, 100);
    await arrive(lamp.id, 1, 100);
    await postMovement(prisma, {
      productId: lamp.id,
      quantity: 1,
      from: millBack,
      reason: "DELIVER",
    });
    const value = await getInventoryValue(prisma, {});
    expect(value.rows.map((r) => r.key)).toEqual(["Seating"]);
  });

  it("groups by vendor when asked, and counts stock with no cost", async () => {
    await prisma.product.update({ where: { id: lamp.id }, data: { baseCost: 0 } });
    await arrive(lamp.id, 2, 10);
    const value = await getInventoryValue(prisma, { pivot: "vendor" });
    expect(value.rows).toEqual([
      { key: "Heron", units: 2, costValue: 0, retailValue: 1000, uncostedUnits: 2 },
    ]);
  });

  it("gives no number for a day before the journal, and says where it starts", async () => {
    await arrive(sofa.id, 3, 100);
    const start = addDays(today, -100);
    const before = await getInventoryValue(prisma, { asOf: addDays(start, -1) });
    expect(before).toMatchObject({ beforeJournal: true, journalStartsOn: start, rows: [] });
    expect(before.totals.units).toBe(0);
    const onTheDay = await getInventoryValue(prisma, { asOf: start });
    expect(onTheDay.beforeJournal).toBe(false);
    expect(onTheDay.totals.units).toBe(3);
  });

  it("with an empty journal says nothing has moved", async () => {
    const value = await getInventoryValue(prisma, {});
    expect(value).toMatchObject({ journalStartsOn: null, beforeJournal: false, rows: [] });
  });

  it("refuses a date in the future or that isn't a date, with a reason", async () => {
    const mia = reportsAs("mia");
    await expect(mia.inventoryValue({ asOf: addDays(today, 1) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/today/),
    });
    await expect(mia.inventoryValue({ asOf: "2026-13-40" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/YYYY-MM-DD/),
    });
  });

  it("strips cost without View cost, in retail order", async () => {
    await arrive(sofa.id, 2, 10);
    await arrive(lamp.id, 1, 10);
    const holder = await reportsAs("mia").inventoryValue({});
    expect(holder.rows.map((r) => r.key)).toEqual(["Seating", "Lighting"]);
    const data = await reportsAs("ada").inventoryValue({});
    expect(data.costVisible).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/costValue|uncostedUnits/);
    expect(data.rows.map((r) => r.key)).toEqual(["Lighting", "Seating"]);
  });

  it("a designer isn't let in, and the page hands a manager the stores and today", async () => {
    await expect(reportsAs("dana").inventoryValue({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    signInToPages("dana");
    await expect(InventoryValuePage()).rejects.toThrow(/REDIRECT/);
    signInToPages("mia");
    const page = await InventoryValuePage();
    expect(page.props.today).toBe(today);
    expect(page.props.stores.map((s: { name: string }) => s.name)).toEqual(["DOCK", "MILL"]);
  });
});

describe("the journal's backdated writer", () => {
  it("records the date it's given", async () => {
    const when = daysAgo(40);
    await arrive(sofa.id, 1, 40);
    const row = await prisma.stockMovement.findFirstOrThrow({ where: { productId: sofa.id } });
    expect(Math.abs(row.occurredAt.getTime() - when.getTime())).toBeLessThan(5000);
  });

  it("refuses a date that hasn't happened", async () => {
    await expect(
      postBackdatedMovement(
        prisma,
        { productId: sofa.id, quantity: 1, to: millBack, reason: "RECEIVE" },
        new Date(Date.now() + DAY),
      ),
    ).rejects.toThrow(/in the past/);
    expect(await prisma.stockMovement.count()).toBe(0);
  });
});

async function transfer(
  over: Partial<{
    quantity: number;
    receivedQuantity: number;
    status: string;
    shippedAt: Date | null;
    created: Date;
    receivedAt: Date | null;
    from: number;
    to: number;
    fromName: string;
    toName: string;
    productId: number;
    fromStockLocationId: number;
  }> = {},
) {
  return prisma.inventoryTransfer.create({
    data: {
      productId: over.productId ?? sofa.id,
      quantity: over.quantity ?? 2,
      receivedQuantity: over.receivedQuantity ?? 0,
      status: (over.status ?? "IN_TRANSIT") as InventoryTransferStatus,
      fromLocation: over.fromName ?? "MILL",
      toLocation: over.toName ?? "DOCK",
      fromLocationId: over.from ?? mill.id,
      toLocationId: over.to ?? dock.id,
      fromStockLocationId: over.fromStockLocationId,
      requestedByUserId: "mia",
      shippedAt: over.shippedAt === undefined ? daysAgo(5) : over.shippedAt,
      receivedAt: over.receivedAt ?? null,
      ...(over.created ? { created: over.created } : {}),
    },
  });
}

const PERIOD = () => ({ startDate: addDays(today, -30), endDate: today });

describe("Transfers report", () => {
  it("moved means what left: on its way or received, not a draft or a cancelled one", async () => {
    await transfer({ status: "IN_TRANSIT", quantity: 2 });
    await transfer({ status: "RECEIVED", quantity: 3, receivedQuantity: 3 });
    await transfer({ status: "DRAFT", quantity: 50, shippedAt: null });
    await transfer({ status: "CANCELLED", quantity: 70 });
    const data = await reportsAs("mia").transfersReport(PERIOD());
    expect(data.view).toBe("moved");
    expect(data.totals).toMatchObject({ transfers: 2, units: 5, received: 3, costValue: 500 });
  });

  it("gives each of the others its own view", async () => {
    await transfer({ status: "IN_TRANSIT", quantity: 2 });
    await transfer({ status: "RECEIVED", quantity: 3, receivedQuantity: 3 });
    await transfer({ status: "DRAFT", quantity: 50, shippedAt: null, created: daysAgo(3) });
    await transfer({ status: "CANCELLED", quantity: 70 });
    const units = async (view: "received" | "draft" | "cancelled" | "in_transit") =>
      (await reportsAs("mia").transfersReport({ ...PERIOD(), view })).totals.units;
    expect(await units("received")).toBe(3);
    expect(await units("draft")).toBe(50);
    expect(await units("cancelled")).toBe(70);
    expect(await units("in_transit")).toBe(2);
  });

  it("dates a transfer by when it was sent, and leaves out what's outside the period", async () => {
    await transfer({ quantity: 1, shippedAt: daysAgo(5) });
    await transfer({
      quantity: 2,
      shippedAt: daysAgo(60),
      status: "RECEIVED",
      receivedQuantity: 2,
    });
    // Sent inside the period though created before it.
    await transfer({ quantity: 4, shippedAt: daysAgo(5), created: daysAgo(90) });
    const data = await reportsAs("mia").transfersReport(PERIOD());
    expect(data.totals.units).toBe(5);
    expect(data.rows.map((r) => r.sentOn)).toEqual([
      businessDayKey(daysAgo(5), timeZone),
      businessDayKey(daysAgo(5), timeZone),
    ]);
  });

  it("a draft that was never sent goes by the day it was created", async () => {
    await transfer({ status: "DRAFT", quantity: 1, shippedAt: null, created: daysAgo(90) });
    await transfer({ status: "DRAFT", quantity: 2, shippedAt: null, created: daysAgo(3) });
    const data = await reportsAs("mia").transfersReport({ ...PERIOD(), view: "draft" });
    expect(data.totals.units).toBe(2);
  });

  it("includes the period's first and last store days", async () => {
    const day = addDays(today, -10);
    await transfer({ quantity: 1, shippedAt: businessHourStart(day, 0, timeZone) });
    await transfer({ quantity: 2, shippedAt: businessHourStart(day, 23, timeZone) });
    await transfer({ quantity: 4, shippedAt: businessHourStart(addDays(day, 1), 0, timeZone) });
    await transfer({
      quantity: 8,
      shippedAt: new Date(businessHourStart(day, 0, timeZone).getTime() - 1000),
    });
    const data = await reportsAs("mia").transfersReport({ startDate: day, endDate: day });
    expect(data.totals.units).toBe(3);
  });

  it("leaves zero-quantity rows out (rule 31)", async () => {
    await transfer({ quantity: 0 });
    const data = await reportsAs("mia").transfersReport(PERIOD());
    expect(data.totals.transfers).toBe(0);
    expect(data.inTransitNow.transfers).toBe(0);
  });

  it("never hides a stuck transfer behind the period", async () => {
    await transfer({ quantity: 3, shippedAt: daysAgo(120) });
    await transfer({ quantity: 5, receivedQuantity: 2, shippedAt: daysAgo(4) });
    await transfer({ quantity: 9, status: "RECEIVED", receivedQuantity: 9, shippedAt: daysAgo(4) });
    const moved = await reportsAs("mia").transfersReport(PERIOD());
    // The 120-day-old one is outside "moved" for this period and still counted
    // in what's on its way, as what is left to arrive.
    expect(moved.totals.units).toBe(14);
    expect(moved.inTransitNow).toEqual({ transfers: 2, units: 6, oldestDays: 120 });
    const onTheWay = await reportsAs("mia").transfersReport({ ...PERIOD(), view: "in_transit" });
    expect(onTheWay.rows).toHaveLength(2);
    expect(onTheWay.rows[1]).toMatchObject({ daysOnTheWay: 120 });
  });

  it("says how many days a transfer has been on its way, and nothing once it's arrived", async () => {
    await transfer({ shippedAt: daysAgo(7) });
    await transfer({
      status: "RECEIVED",
      receivedQuantity: 2,
      shippedAt: daysAgo(9),
      receivedAt: daysAgo(2),
    });
    const { rows } = await reportsAs("mia").transfersReport(PERIOD());
    expect(rows[0].daysOnTheWay).toBe(daysBetween(businessDayKey(daysAgo(7), timeZone), today));
    expect(rows[1].daysOnTheWay).toBeNull();
    expect(rows[1].receivedOn).toBe(businessDayKey(daysAgo(2), timeZone));
  });

  it("filters to a store on either end of the route", async () => {
    const third = await prisma.storeLocation.create({
      data: { name: "THIRD", code: "THIRD", type: "STORE" },
    });
    await transfer({ quantity: 1, from: mill.id, to: dock.id });
    await transfer({ quantity: 2, from: dock.id, to: third.id, fromName: "DOCK", toName: "THIRD" });
    await transfer({ quantity: 4, from: third.id, to: mill.id, fromName: "THIRD", toName: "MILL" });
    const units = async (storeLocationId: number) =>
      (await reportsAs("mia").transfersReport({ ...PERIOD(), storeLocationId })).totals.units;
    expect(await units(mill.id)).toBe(5);
    expect(await units(dock.id)).toBe(3);
    expect(await units(third.id)).toBe(6);
    const stuck = await reportsAs("mia").transfersReport({
      ...PERIOD(),
      storeLocationId: dock.id,
    });
    expect(stuck.inTransitNow.units).toBe(3);
  });

  it("totals each route, by the store's name", async () => {
    await transfer({ quantity: 1, from: mill.id, to: dock.id, fromName: "old name" });
    await transfer({ quantity: 3, from: mill.id, to: dock.id });
    await transfer({ quantity: 2, from: dock.id, to: mill.id, fromName: "DOCK", toName: "MILL" });
    const { routes } = await reportsAs("mia").transfersReport(PERIOD());
    expect(routes).toEqual([
      { from: "MILL", to: "DOCK", transfers: 2, units: 4, received: 0, costValue: 400 },
      { from: "DOCK", to: "MILL", transfers: 1, units: 2, received: 0, costValue: 200 },
    ]);
  });

  it("falls back to the transfer's own words for a route with no store on record", async () => {
    await prisma.inventoryTransfer.create({
      data: {
        productId: sofa.id,
        quantity: 1,
        status: "IN_TRANSIT",
        fromLocation: "Old annex",
        toLocation: "New annex",
        requestedByUserId: "mia",
        shippedAt: daysAgo(1),
      },
    });
    const { routes } = await reportsAs("mia").transfersReport(PERIOD());
    expect(routes[0]).toMatchObject({ from: "Old annex", to: "New annex" });
  });

  it("names the places on a row, and totals everything even past the row limit", async () => {
    const [back] = await prisma.stockLocation.findMany({ where: { code: "MILL-BACK" } });
    await transfer({ quantity: 1, fromStockLocationId: back.id, shippedAt: daysAgo(1) });
    await prisma.inventoryTransfer.createMany({
      data: Array.from({ length: TRANSFER_ROW_LIMIT }, () => ({
        productId: lamp.id,
        quantity: 1,
        status: "RECEIVED",
        receivedQuantity: 1,
        fromLocation: "MILL",
        toLocation: "DOCK",
        fromLocationId: mill.id,
        toLocationId: dock.id,
        requestedByUserId: "mia",
        shippedAt: daysAgo(2),
      })),
    });
    const data = await reportsAs("mia").transfersReport(PERIOD());
    expect(data.rows).toHaveLength(TRANSFER_ROW_LIMIT);
    expect(data.totals.transfers).toBe(TRANSFER_ROW_LIMIT + 1);
    expect(data.rows[0]).toMatchObject({ fromPlace: "MILL-BACK", toPlace: null });
  });

  it("refuses dates that aren't dates or run backwards, with a reason", async () => {
    const mia = reportsAs("mia");
    await expect(mia.transfersReport({ startDate: "soon", endDate: today })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/YYYY-MM-DD/),
    });
    await expect(
      mia.transfersReport({ startDate: today, endDate: addDays(today, -1) }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/on or before/),
    });
  });

  it("strips cost without View cost", async () => {
    await transfer();
    const holder = await reportsAs("mia").transfersReport(PERIOD());
    expect(holder.costVisible).toBe(true);
    expect(holder.rows[0]).toHaveProperty("costValue", 200);
    const data = await reportsAs("ada").transfersReport(PERIOD());
    expect(data.costVisible).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/costValue/);
    expect(data.totals.units).toBe(holder.totals.units);
  });

  it("is open to reporting.read and closed without it, by the router and the page", async () => {
    await transfer();
    await expect(reportsAs("ian").transfersReport(PERIOD())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    signInToPages("ian");
    await expect(TransfersReportPage()).rejects.toThrow(/REDIRECT/);
    signInToPages("dana");
    const page = await TransfersReportPage();
    expect(page.props.today).toBe(today);
    expect(page.props.stores).toHaveLength(2);
    const data = await reportsAs("dana").transfersReport(PERIOD());
    expect(data.totals.transfers).toBe(1);
  });
});

describe("the counting schedule", () => {
  const place = (code: string, data: Record<string, unknown> = {}) =>
    prisma.stockLocation.create({
      data: { storeLocationId: mill.id, code, name: code, countEveryDays: 30, ...data } as never,
    });

  const schedule = async () => {
    const res = await callRoute(countsHandler as never, "GET", {});
    expect(res.statusCode).toBe(200);
    return res.body.schedule;
  };

  const count = async (
    stockLocationId: number,
    days: number,
    how: "post" | "leave" | "cancel" = "post",
    scope: "PLACE" | "PRODUCTS" = "PLACE",
  ) => {
    const { id } = await prisma.$transaction((tx) =>
      submitCount(tx, {
        storeLocationId: mill.id,
        stockLocationId,
        scope,
        lines: scope === "PRODUCTS" ? [{ productId: sofa.id, counted: 0 }] : [],
        actor: "mia",
      }),
    );
    await prisma.stockCount.update({ where: { id }, data: { countedAt: daysAgo(days) } });
    if (how === "post") await prisma.$transaction((tx) => postCount(tx, id, { actor: "mia" }));
    if (how === "cancel") await prisma.$transaction((tx) => cancelCount(tx, id, "mia"));
    return id;
  };

  it("has nothing on it until a store sets one", async () => {
    await prisma.stockLocation.create({
      data: { storeLocationId: mill.id, code: "PLAIN", name: "PLAIN" },
    });
    expect(await schedule()).toEqual([]);
  });

  it("reads a place never counted as due now", async () => {
    await place("A");
    expect(await schedule()).toMatchObject([
      { place: "A", store: "MILL", standing: "DUE", lastCountedOn: null, dueOn: null },
    ]);
  });

  it("resets on a posted count of everything in the place", async () => {
    const a = await place("A");
    await count(a.id, 10);
    const [row] = await schedule();
    expect(row).toMatchObject({
      standing: "NOT_YET",
      lastCountedOn: businessDayKey(daysAgo(10), timeZone),
      dueOn: addDays(businessDayKey(daysAgo(10), timeZone), 30),
      daysLate: 0,
    });
  });

  it("uses the latest posted count, and goes overdue by the store's days", async () => {
    const a = await place("A");
    await count(a.id, 200);
    await count(a.id, 35);
    const [row] = await schedule();
    expect(row.standing).toBe("OVERDUE");
    expect(row.daysLate).toBe(5);
  });

  it("a quick count of a few products doesn't reset it", async () => {
    const a = await place("A");
    await count(a.id, 2, "post", "PRODUCTS");
    expect((await schedule())[0]).toMatchObject({ standing: "DUE", lastCountedOn: null });
  });

  it("a cancelled count doesn't reset it", async () => {
    const a = await place("A");
    await count(a.id, 2, "cancel");
    expect((await schedule())[0]).toMatchObject({ standing: "DUE", lastCountedOn: null });
  });

  it("a count waiting to be posted reads as waiting, not as more to count", async () => {
    const a = await place("A");
    await count(a.id, 2, "leave");
    expect((await schedule())[0]).toMatchObject({ standing: "WAITING", lastCountedOn: null });
  });

  it("a waiting count doesn't hide that the place isn't due yet", async () => {
    const a = await place("A");
    await count(a.id, 5);
    await count(a.id, 1, "leave");
    expect((await schedule())[0].standing).toBe("NOT_YET");
  });

  it("a quick count waiting to be posted doesn't read as waiting", async () => {
    const a = await place("A");
    await count(a.id, 2, "leave", "PRODUCTS");
    expect((await schedule())[0].standing).toBe("DUE");
  });

  it("leaves out a retired place and one that became a group", async () => {
    await place("OLD", { isActive: false });
    await place("BLDG", { locationType: "GROUP" });
    expect(await schedule()).toEqual([]);
  });

  it("puts what most needs counting first", async () => {
    const soon = await place("SOON");
    const late = await place("LATE");
    const later = await place("LATER");
    const waiting = await place("WAITING");
    await place("NEVER");
    await count(soon.id, 1);
    await count(late.id, 35);
    await count(later.id, 60);
    await count(waiting.id, 1, "leave");
    expect((await schedule()).map((r) => r.place)).toEqual([
      "LATER",
      "LATE",
      "NEVER",
      "WAITING",
      "SOON",
    ]);
  });

  describe("setting it", () => {
    const put = (id: number, body: Record<string, unknown>) =>
      callRoute(placeHandler as never, "PUT", { id: String(id) }, body);

    it("saves on a place, and clears", async () => {
      const a = await place("A", { countEveryDays: null });
      expect((await put(a.id, { countEveryDays: 45 })).statusCode).toBe(200);
      expect(
        (await prisma.stockLocation.findUniqueOrThrow({ where: { id: a.id } })).countEveryDays,
      ).toBe(45);
      expect((await put(a.id, { countEveryDays: null })).statusCode).toBe(200);
      expect(
        (await prisma.stockLocation.findUniqueOrThrow({ where: { id: a.id } })).countEveryDays,
      ).toBeNull();
    });

    it("an edit that doesn't mention it leaves it alone", async () => {
      const a = await place("A", { countEveryDays: 45 });
      expect((await put(a.id, { name: "Renamed" })).statusCode).toBe(200);
      expect(
        (await prisma.stockLocation.findUniqueOrThrow({ where: { id: a.id } })).countEveryDays,
      ).toBe(45);
    });

    it.each([0, -1, 1.5, COUNT_EVERY_DAYS_MAX + 1, "30"])("refuses %p on an edit", async (bad) => {
      const a = await place("A", { countEveryDays: null });
      const res = await put(a.id, { countEveryDays: bad });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/whole number of days/);
    });

    it("refuses a schedule on a group, on an edit and when it becomes one", async () => {
      const group = await place("G", { locationType: "GROUP", countEveryDays: null });
      const res = await put(group.id, { countEveryDays: 30 });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/groups other places/);
      const plain = await place("P", { countEveryDays: null });
      const both = await put(plain.id, { locationType: "GROUP", countEveryDays: 30 });
      expect(both.statusCode).toBe(400);
    });

    it("saves when a new place is created, and refuses the same things", async () => {
      const post = (body: Record<string, unknown>) =>
        callRoute(storePlacesHandler as never, "POST", { id: String(mill.id) }, body);
      const ok = await post({ code: "NEW", name: "NEW", countEveryDays: 60 });
      expect(ok.statusCode).toBe(201);
      expect(ok.body.countEveryDays).toBe(60);
      const none = await post({ code: "NONE", name: "NONE" });
      expect(none.body.countEveryDays).toBeNull();
      expect((await post({ code: "BAD", name: "BAD", countEveryDays: 0 })).statusCode).toBe(400);
      const group = await post({ code: "G", name: "G", locationType: "GROUP", countEveryDays: 5 });
      expect(group.statusCode).toBe(400);
    });

    it("the location list carries it, since the edit form sends back what it loaded", async () => {
      await place("A", { countEveryDays: 45 });
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: "mia", email: "mia@example.com", role: "MANAGER" },
      });
      const res = makeRes();
      await locationsHandler({ method: "GET", query: {} } as unknown as NextApiRequest, res);
      const places = res.body.locations.flatMap((l) => l.stockLocations);
      expect(places.find((p) => p.code === "A")?.countEveryDays).toBe(45);
    });

    it("the database refuses what the route would", async () => {
      await expect(place("BAD", { countEveryDays: 0 })).rejects.toThrow();
      await expect(place("BAD2", { countEveryDays: COUNT_EVERY_DAYS_MAX + 1 })).rejects.toThrow();
    });
  });
});
