// /app/__tests__/integration/lowStock.integration.test.ts
//
// GAP-14: reorder points and the low-stock alert.
//
// Before: the schema had no minimum or reorder field. The Buyers report flagged
// fast sellers with under two weeks of supply, but only as a report, and nothing
// told anyone an item they mean to keep had run down.
//
// Real routes and libraries, real database, stock through the real ledger.

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
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { postMovement } from "@/lib/inventory/ledger";
import { lowStockRows } from "@/lib/purchasing/lowStock";
import { queueLowStockAlert } from "@/lib/purchasing/lowStockAlert";
import { businessHourStart } from "@/lib/reports/businessDay";
import lowStockRoute, { handler as lowStock } from "@/pages/api/purchasing/low-stock";
import pointsRoute, { handleWrite } from "@/pages/api/products/[id]/reorder-points";
import { handler as scanOrder } from "@/pages/api/scan/order";
import settingsRoute from "@/pages/api/admin/settings/index";
import emailQueueRoute from "@/pages/api/automations/email-queue";
import ProductDetailPage from "@/app/(dashboard)/app/inventory/products/[id]/page";
import LowStockPage from "@/app/(dashboard)/app/purchasing/low-stock/page";

const sessionMock = getServerSession as jest.Mock;
const buyer = { user: { id: "b", email: "buyer@example.com" } } as unknown as Session;
const TZ = "America/New_York";

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

function request(
  method: string,
  query: Record<string, string> = {},
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return { method, query, body, cookies: {}, headers } as unknown as NextApiRequest;
}

async function world() {
  const org = await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });
  const vendor = await prisma.vendor.create({ data: { name: "Anchor", pricingModel: "FLAT" } });
  const other = await prisma.vendor.create({ data: { name: "Birch", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "Lamps", departmentId: department.id, trackInventory: true },
  });
  const notStocked = await prisma.category.create({
    data: { name: "Plans", departmentId: department.id, trackInventory: false },
  });
  let n = 0;
  const product = (data: Record<string, unknown> = {}) => {
    n += 1;
    return prisma.product.create({
      data: {
        productNumber: `P${n}`,
        name: `Item ${n}`,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
        baseCost: 10,
        ...data,
      },
    });
  };
  const place = (storeLocationId: number, code: string, locationType?: string) =>
    prisma.stockLocation.create({
      data: {
        storeLocationId,
        code,
        name: code,
        ...(locationType ? { locationType: locationType as never } : {}),
      },
    });
  const mill = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const harbor = await prisma.storeLocation.create({
    data: { name: "Harbor", code: "HARB", type: "STORE" },
  });
  const shelf = await place(mill.id, "SHELF");
  const harborShelf = await place(harbor.id, "HSHELF");
  const stock = (
    productId: number,
    quantity: number,
    at: { storeLocationId: number; id: number } = shelf,
    salesOrderId?: number,
  ) =>
    prisma.$transaction((tx) =>
      postMovement(tx, {
        productId,
        quantity,
        to: {
          storeLocationId: at.storeLocationId,
          stockLocationId: at.id,
          salesOrderId: salesOrderId ?? null,
        },
        reason: "RECEIVE",
        source: { type: "PurchaseOrder", id: 1 },
        actor: "test",
      }),
    );
  let poN = 0;
  const po = (
    productId: number,
    quantity: number,
    status: string,
    data: Record<string, unknown> = {},
    lineData: Record<string, unknown> = {},
  ) => {
    poN += 1;
    return prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-${poN}`,
        vendorId: vendor.id,
        status: status as never,
        shipToLocationId: mill.id,
        ...data,
        lineItems: {
          create: [{ productId, orderedQuantity: quantity, unitCost: 10, ...lineData }],
        },
      },
      include: { lineItems: true },
    });
  };
  const keep = (
    productId: number,
    minQuantity: number,
    storeLocationId = mill.id,
    orderQuantity?: number,
  ) =>
    prisma.reorderPoint.create({
      data: { productId, storeLocationId, minQuantity, orderQuantity: orderQuantity ?? null },
    });
  return {
    org,
    vendor,
    other,
    category,
    notStocked,
    product,
    place,
    mill,
    harbor,
    shelf,
    harborShelf,
    stock,
    po,
    keep,
  };
}

let w: Awaited<ReturnType<typeof world>>;

beforeEach(async () => {
  await resetTestDb();
  invalidateAppSettingsCache();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  w = await world();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const rows = () => lowStockRows(prisma);

describe("what's low, and what counts", () => {
  it("lists an item below its level, and not one at it or with no level", async () => {
    const low = await w.product();
    const at = await w.product();
    const noLevel = await w.product();
    await w.stock(low.id, 1);
    await w.stock(at.id, 3);
    await w.stock(noLevel.id, 1);
    await w.keep(low.id, 3);
    await w.keep(at.id, 3);
    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      productId: low.id,
      productName: low.name,
      vendor: "Anchor",
      store: "Mill",
      minQuantity: 3,
      free: 1,
      onOrder: 0,
      onDraft: 0,
      shortBy: 2,
      suggested: 2,
    });
  });

  it("lists an item with no stock at all", async () => {
    const empty = await w.product();
    await w.keep(empty.id, 2);
    expect((await rows())[0]).toMatchObject({ free: 0, shortBy: 2 });
  });

  it("holds each store to its own level, with its own stock", async () => {
    const item = await w.product();
    await w.stock(item.id, 5, w.shelf);
    await w.keep(item.id, 2, w.mill.id);
    await w.keep(item.id, 2, w.harbor.id);
    const list = await rows();
    expect(list.map((r) => [r.store, r.free])).toEqual([["Harbor", 0]]);
    expect(await lowStockRows(prisma, { storeLocationId: w.mill.id })).toEqual([]);
  });

  it("doesn't count stock that can't be sold: committed, on display or quarantined", async () => {
    const item = await w.product();
    const display = await w.place(w.mill.id, "FLOORDISP", "DISPLAY");
    const quarantine = await w.place(w.mill.id, "QUAR", "QUARANTINE");
    const order = await prisma.salesOrder.create({
      data: { orderno: "SO-1", status: "ORDER", orderDate: new Date() },
    });
    await w.stock(item.id, 4, w.shelf, order.id);
    await w.stock(item.id, 4, display);
    await w.stock(item.id, 4, quarantine);
    await w.stock(item.id, 1, w.shelf);
    await w.keep(item.id, 3);
    expect((await rows())[0]).toMatchObject({ free: 1, shortBy: 2 });
  });

  it("counts what's left to come on POs sent to this store", async () => {
    const item = await w.product();
    await w.stock(item.id, 1);
    await w.keep(item.id, 6);
    await w.po(item.id, 2, "SUBMITTED");
    await w.po(item.id, 1, "CONFIRMED");
    expect((await rows())[0]).toMatchObject({ free: 1, onOrder: 3, shortBy: 2 });

    // A part received counts only for what's left.
    const partly = await w.po(item.id, 5, "RECEIVED_PARTIAL");
    await prisma.user.create({ data: { id: "r", email: "r@example.com" } });
    await prisma.receivingRecord.create({
      data: {
        purchaseOrderId: partly.id,
        purchaseOrderItemId: partly.lineItems[0].id,
        quantityReceived: 4,
        receiverUserId: "r",
      },
    });
    expect((await rows())[0]).toMatchObject({ onOrder: 4, shortBy: 1 });
  });

  it("credits a PO to the store it ships to, not another with a level", async () => {
    const item = await w.product();
    await w.keep(item.id, 5, w.mill.id);
    await w.keep(item.id, 5, w.harbor.id);
    await w.po(item.id, 2, "SUBMITTED", { shipToLocationId: w.harbor.id });
    await w.po(item.id, 1, "DRAFT", { shipToLocationId: w.harbor.id });
    const byStore = Object.fromEntries((await rows()).map((r) => [r.store, r]));
    expect(byStore.Mill).toMatchObject({ onOrder: 0, onDraft: 0 });
    expect(byStore.Harbor).toMatchObject({ onOrder: 2, onDraft: 1 });
  });

  it("doesn't count a PO that isn't stock on its way here", async () => {
    const item = await w.product();
    await w.keep(item.id, 2);
    const order = await prisma.salesOrder.create({
      data: { orderno: "SO-2", status: "ORDER", orderDate: new Date() },
    });
    const line = await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        productId: item.id,
        orderedQuantity: 9,
        netPrice: 1,
        cost: 1,
      },
    });
    await w.po(item.id, 9, "CANCELLED");
    await w.po(item.id, 9, "RECEIVED_FULL");
    await w.po(item.id, 9, "SHORT_CLOSED");
    await w.po(item.id, 9, "SUBMITTED", { shipToLocationId: w.harbor.id });
    await w.po(item.id, 9, "SUBMITTED", { shipToLocationId: null });
    await w.po(item.id, 9, "SUBMITTED", { isReturn: true });
    await w.po(item.id, 9, "SUBMITTED", { salesOrderId: order.id });
    await w.po(item.id, 9, "SUBMITTED", {}, { orderLineItemId: line.id });
    expect((await rows())[0]).toMatchObject({ onOrder: 0, onDraft: 0, shortBy: 2 });
  });

  it("keeps it on the list with a draft, without suggesting it twice", async () => {
    const item = await w.product();
    await w.keep(item.id, 3);
    await w.po(item.id, 2, "DRAFT");
    expect((await rows())[0]).toMatchObject({ onOrder: 0, onDraft: 2, shortBy: 3, suggested: 1 });
    await w.po(item.id, 1, "DRAFT");
    expect((await rows())[0]).toMatchObject({ onDraft: 3, shortBy: 3, suggested: 0 });
  });

  it("orders at least the least the store set", async () => {
    const item = await w.product();
    await w.stock(item.id, 2);
    await w.keep(item.id, 3, w.mill.id, 12);
    expect((await rows())[0]).toMatchObject({ shortBy: 1, suggested: 12 });
  });

  it("leaves out a retired item, one that keeps no stock, and a closed store", async () => {
    const retired = await w.product({ isDiscontinued: true });
    const inactive = await w.product({ isActive: false });
    const plan = await w.product({ categoryId: w.notStocked.id });
    const atClosed = await w.product();
    await w.keep(retired.id, 2);
    await w.keep(inactive.id, 2);
    await w.keep(plan.id, 2);
    await w.keep(atClosed.id, 2, w.harbor.id);
    await prisma.storeLocation.update({ where: { id: w.harbor.id }, data: { isActive: false } });
    expect(await rows()).toEqual([]);
  });

  it("narrows by store and vendor, and sorts by store then how far below", async () => {
    const a = await w.product();
    const b = await w.product({ vendorId: w.other.id });
    const c = await w.product();
    await w.keep(a.id, 1);
    await w.keep(b.id, 5);
    await w.keep(c.id, 2, w.harbor.id);
    expect((await rows()).map((r) => r.productId)).toEqual([c.id, b.id, a.id]);
    expect((await lowStockRows(prisma, { vendorId: w.other.id })).map((r) => r.productId)).toEqual([
      b.id,
    ]);
    const res = makeRes();
    await lowStock(request("GET", { storeLocationId: String(w.harbor.id) }), res);
    expect(res.body.rows.map((r: { productId: number }) => r.productId)).toEqual([c.id]);
  });
});

describe("setting a level", () => {
  const put = (productId: number, body: unknown) => {
    const res = makeRes();
    return Promise.resolve(
      handleWrite(request("PUT", { id: String(productId) }, body), res, buyer),
    ).then(() => res);
  };

  it("saves, changes and removes a level per store, and says who", async () => {
    const item = await w.product();
    const res = await put(item.id, {
      storeLocationId: w.mill.id,
      minQuantity: "4",
      orderQuantity: "6",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.points).toEqual([
      { storeLocationId: w.mill.id, minQuantity: 4, orderQuantity: 6 },
    ]);
    expect(res.body.stores.map((s: { name: string }) => s.name)).toEqual(["Harbor", "Mill"]);
    expect(await prisma.reorderPoint.findFirst()).toMatchObject({ createdBy: "buyer@example.com" });

    const changed = await put(item.id, { storeLocationId: w.mill.id, minQuantity: 2.5 });
    expect(changed.body.points).toEqual([
      { storeLocationId: w.mill.id, minQuantity: 2.5, orderQuantity: null },
    ]);
    expect(await prisma.reorderPoint.count()).toBe(1);
    expect(await prisma.reorderPoint.findFirst()).toMatchObject({ updatedBy: "buyer@example.com" });

    const del = makeRes();
    await handleWrite(
      request("DELETE", { id: String(item.id), storeLocationId: String(w.mill.id) }),
      del,
      buyer,
    );
    expect(del.body.points).toEqual([]);
  });

  it("removes one store's level and leaves the others", async () => {
    const item = await w.product();
    await w.keep(item.id, 2, w.mill.id);
    await w.keep(item.id, 2, w.harbor.id);
    const res = makeRes();
    await handleWrite(
      request("DELETE", { id: String(item.id), storeLocationId: String(w.mill.id) }),
      res,
      buyer,
    );
    expect(res.body.points.map((p: { storeLocationId: number }) => p.storeLocationId)).toEqual([
      w.harbor.id,
    ]);
  });

  it("refuses a level that isn't above zero, a closed store, and an item that keeps no stock", async () => {
    const item = await w.product();
    const plan = await w.product({ categoryId: w.notStocked.id });
    const at = { storeLocationId: w.mill.id };
    expect((await put(item.id, { ...at, minQuantity: 0 })).statusCode).toBe(400);
    expect((await put(item.id, { ...at, minQuantity: "x" })).statusCode).toBe(400);
    expect((await put(item.id, { ...at, minQuantity: 2, orderQuantity: -1 })).statusCode).toBe(400);
    await prisma.storeLocation.update({ where: { id: w.harbor.id }, data: { isActive: false } });
    const closed = await put(item.id, { storeLocationId: w.harbor.id, minQuantity: 2 });
    expect(closed.statusCode).toBe(400);
    expect((await put(item.id, { storeLocationId: "x", minQuantity: 2 })).statusCode).toBe(400);
    const stockless = await put(plan.id, { ...at, minQuantity: 2 });
    expect(stockless.statusCode).toBe(400);
    expect(stockless.body.error).toContain(plan.name);
    expect((await put(99999, { ...at, minQuantity: 2 })).statusCode).toBe(404);
    expect(await prisma.reorderPoint.count()).toBe(0);
  });

  it("the database refuses a level or a least order that isn't above zero", async () => {
    const item = await w.product();
    await expect(w.keep(item.id, 0)).rejects.toThrow();
    await expect(w.keep(item.id, 2, w.mill.id, 0)).rejects.toThrow();
  });
});

describe("ordering from the list", () => {
  it("files it on the vendor's draft for the store, once, and stops suggesting it", async () => {
    const item = await w.product();
    await w.keep(item.id, 3);
    const [row] = await rows();
    const body = {
      actionKey: "lowstock-test-1",
      shipToLocationId: w.mill.id,
      lines: [{ productId: row.productId, vendorId: row.vendorId, quantity: row.suggested }],
    };
    const res = makeRes();
    await scanOrder(request("POST", {}, body), res, buyer);
    expect(res.statusCode).toBe(201);
    // What the screen reads to list the POs it filed on.
    expect(res.body.pos).toEqual([expect.objectContaining({ vendor: "Anchor", created: true })]);
    expect(await prisma.purchaseOrder.count({ where: { status: "DRAFT" } })).toBe(1);
    expect((await rows())[0]).toMatchObject({ onDraft: 3, suggested: 0 });

    // Sent, it's on its way, and off the list.
    await prisma.purchaseOrder.updateMany({ data: { status: "SUBMITTED" } });
    expect(await rows()).toEqual([]);
  });
});

describe("the daily alert", () => {
  const set = (data: Record<string, unknown>) =>
    prisma.appSettings.upsert({
      where: { organizationId: DEFAULT_ORG_ID },
      create: { organizationId: DEFAULT_ORG_ID, ...data },
      update: data,
    });
  const at = (hour: number, day = "2031-06-12") => businessHourStart(day, hour, TZ);
  const settings = async (data: Record<string, unknown>) => {
    await set(data);
    invalidateAppSettingsCache();
  };

  it("is off until an address and an hour are set", async () => {
    const item = await w.product();
    await w.keep(item.id, 2);
    expect(await queueLowStockAlert(at(12))).toBe("off");
    await settings({ lowStockAlertEmails: "buyer@example.com" });
    expect(await queueLowStockAlert(at(12))).toBe("off");
    await settings({ lowStockAlertEmails: null, lowStockAlertHour: 9 });
    expect(await queueLowStockAlert(at(12))).toBe("off");
    expect(await prisma.emailQueue.count()).toBe(0);
  });

  it("goes after its hour, to each address, once a store day", async () => {
    const item = await w.product();
    await w.keep(item.id, 2);
    await settings({ lowStockAlertEmails: "a@example.com, b@example.com", lowStockAlertHour: 9 });

    expect(await queueLowStockAlert(new Date(at(9).getTime() - 60_000))).toBe("not-yet");
    expect(await prisma.emailQueue.count()).toBe(0);

    expect(await queueLowStockAlert(at(9))).toBe(2);
    const emails = await prisma.emailQueue.findMany({ orderBy: { id: "asc" } });
    expect(emails.map((e) => e.toAddress)).toEqual(["a@example.com", "b@example.com"]);
    expect(emails[0].subject).toBe("1 item below their reorder point");
    expect(emails[0].html).toContain(item.name);
    expect(emails[0].html).toContain("/app/purchasing/low-stock");
    expect(emails[0].templateKey).toBe("low-stock");

    expect(await queueLowStockAlert(at(15))).toBe("already-sent");
    expect(await prisma.emailQueue.count()).toBe(2);

    // The next day's goes, by the store's clock.
    expect(await queueLowStockAlert(at(9, "2031-06-13"))).toBe(2);
    expect(await prisma.emailQueue.count()).toBe(4);
  });

  it("sends nothing on a day when nothing is low", async () => {
    await settings({ lowStockAlertEmails: "a@example.com", lowStockAlertHour: 9 });
    expect(await queueLowStockAlert(at(9))).toBe("nothing-low");
    expect(await prisma.emailQueue.count()).toBe(0);
  });

  it("sends one list when two runs ask at once", async () => {
    const item = await w.product();
    await w.keep(item.id, 2);
    await settings({ lowStockAlertEmails: "a@example.com", lowStockAlertHour: 9 });
    await Promise.all([queueLowStockAlert(at(9)), queueLowStockAlert(at(9))]);
    expect(await prisma.emailQueue.count()).toBe(1);
  });

  it("escapes names in the list, and says when a draft covers it", async () => {
    const item = await w.product({ name: "<b>Lamp</b>" });
    await w.keep(item.id, 2);
    await w.po(item.id, 2, "DRAFT");
    await settings({ lowStockAlertEmails: "a@example.com", lowStockAlertHour: 9 });
    await queueLowStockAlert(at(9));
    const { html } = await prisma.emailQueue.findFirstOrThrow();
    expect(html).toContain("&lt;b&gt;Lamp&lt;/b&gt;");
    expect(html).toContain("On a draft");
  });

  it("the email-queue cron sends it", async () => {
    const OLD = process.env.AUTO_IMPORT_API_KEY;
    process.env.AUTO_IMPORT_API_KEY = "test-key";
    const item = await w.product();
    await w.keep(item.id, 2);
    await settings({ lowStockAlertEmails: "a@example.com", lowStockAlertHour: 0 });
    const res = makeRes();
    await emailQueueRoute(
      request("POST", {}, undefined, { authorization: "Bearer test-key" }),
      res,
    );
    process.env.AUTO_IMPORT_API_KEY = OLD;
    expect(res.statusCode).toBe(200);
    expect(res.body.lowStock).toBe(1);
    expect(await prisma.emailQueue.count()).toBe(1);
  });
});

describe("who", () => {
  async function staff() {
    await syncBuiltInRoles({ prisma });
    invalidateRoleGrantCache();
    for (const key of ["ADMIN", "REGISTER", "DESIGNER"] as const) {
      const email = `${key.toLowerCase()}@example.com`;
      await prisma.user.create({ data: { id: key, email } });
      const role = await prisma.role.findUniqueOrThrow({ where: { key } });
      await prisma.staffMember.create({
        data: { userId: key, email, displayName: key, role: key, roleId: role.id },
      });
    }
  }
  const asRole = async (
    key: string,
    route: (q: NextApiRequest, r: NextApiResponse) => unknown,
    method: string,
    query: Record<string, string>,
    body?: unknown,
  ) => {
    sessionMock.mockResolvedValue({ user: { id: key, email: `${key.toLowerCase()}@example.com` } });
    const res = makeRes();
    await route(request(method, query, body), res);
    return res;
  };

  it("lets buyers set levels and read the list, and not others", async () => {
    const item = await w.product();
    await staff();
    const query = { id: String(item.id) };
    const body = { storeLocationId: w.mill.id, minQuantity: 2 };
    expect((await asRole("DESIGNER", pointsRoute, "PUT", query, body)).statusCode).toBe(403);
    expect((await asRole("DESIGNER", pointsRoute, "GET", query)).statusCode).toBe(200);
    expect((await asRole("DESIGNER", lowStockRoute, "GET", {})).statusCode).toBe(200);
    expect((await asRole("REGISTER", lowStockRoute, "GET", {})).statusCode).toBe(403);
    expect((await asRole("REGISTER", pointsRoute, "GET", query)).statusCode).toBe(200);
    expect((await asRole("ADMIN", pointsRoute, "PUT", query, body)).statusCode).toBe(200);
    expect((await asRole("ADMIN", lowStockRoute, "GET", {})).statusCode).toBe(200);
  });

  it("offers the level's form and ordering only to whoever buys, on the pages themselves", async () => {
    const item = await w.product();
    await staff();
    const signIn = (key: string) => {
      (getToken as jest.Mock).mockResolvedValue({ id: key });
      (headers as jest.Mock).mockResolvedValue(new Headers());
      (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
    };
    const productProps = async (key: string) => {
      signIn(key);
      return (await ProductDetailPage({ params: Promise.resolve({ id: String(item.id) }) })).props;
    };
    const listProps = async (key: string) => {
      signIn(key);
      return (await LowStockPage()).props;
    };
    expect(await productProps("ADMIN")).toMatchObject({ canSetReorderPoints: true });
    expect(await productProps("DESIGNER")).toMatchObject({ canSetReorderPoints: false });
    expect(await listProps("ADMIN")).toEqual({ canOrder: true });
    expect(await listProps("DESIGNER")).toEqual({ canOrder: false });
    await expect(listProps("REGISTER")).rejects.toThrow("REDIRECT");
  });

  it("the alert's addresses and hour are saved and checked in Settings", async () => {
    await staff();
    const put = (body: unknown) => asRole("ADMIN", settingsRoute, "PUT", {}, body);
    const good = await put({
      lowStockAlertEmails: "a@example.com; b@example.com",
      lowStockAlertHour: 8,
    });
    expect(good.statusCode).toBe(200);
    expect(await prisma.appSettings.findFirstOrThrow()).toMatchObject({
      lowStockAlertEmails: "a@example.com, b@example.com",
      lowStockAlertHour: 8,
    });
    const bad = await put({ lowStockAlertEmails: "nope" });
    expect([bad.statusCode, bad.body.error]).toEqual([
      400,
      "nope doesn't look like an email address.",
    ]);
    expect((await put({ lowStockAlertHour: 24 })).statusCode).toBe(400);
    expect((await put({ lowStockAlertHour: "8" })).statusCode).toBe(400);
    const off = await put({ lowStockAlertEmails: "", lowStockAlertHour: null });
    expect(off.statusCode).toBe(200);
    expect(await prisma.appSettings.findFirstOrThrow()).toMatchObject({
      lowStockAlertEmails: null,
      lowStockAlertHour: null,
    });
  });
});
