// /app/__tests__/integration/scheduledSales.integration.test.ts
//
// GAP-06 part B against a real database: a scheduled sale's price is what the
// register charges while the sale is on, and every reader agrees.
//
//   - one sale price per product per day: an overlapping sale is refused, also
//     when two are written at once (the second waits on the product's row lock),
//     and a sale is never counted against itself when it changes or previews;
//   - the resolver decides on the store's day, in its time zone: first day, last
//     day, the day after, ended early;
//   - product search and the scan lookup answer the sale price, with the regular;
//   - a register sale at the sale price needs no manager with a 0% limit, records
//     the sale price as its list price, and a further discount is measured from it;
//   - a duplicated order takes today's sale price, and so does a house call's
//     service line;
//   - tags: a SALE tag prints the sale price, the regular as was, and the last
//     day; a PRODUCT tag prints the sale price; batch printing takes a kind;
//   - what may change when: edit before the start, end early once on, no delete
//     once started; the preview's skips; tags to change; and the audit entries.
//
// Only the session readers are mocked; the gate is the real one.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));

import net from "node:net";
import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, getAppSettings, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { addDays } from "@/lib/reports/businessDay";
import { loadActiveSalePrices, saleToday } from "@/lib/pricing/salePrice";
import { createSale, listSales, tagsToChange } from "@/lib/pricing/sales";
import { renderProductTag } from "@/lib/labels/productTag";
import salesRoute, { handler as salesHandler } from "@/pages/api/pricing/sales/index";
import { handler as saleHandler } from "@/pages/api/pricing/sales/[id]";
import { handler as endHandler } from "@/pages/api/pricing/sales/[id]/end";
import { handler as previewHandler } from "@/pages/api/pricing/sales/preview";
import { handler as tagsHandler } from "@/pages/api/pricing/sales/tags-to-change";
import productsRoute from "@/pages/api/products/index";
import findRoute from "@/pages/api/products/find-by-identifier";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as duplicateHandler } from "@/pages/api/sales/orders/[id]/duplicate";
import { handler as batchHandler } from "@/pages/api/print-label/batch";
import houseCallsRoute from "@/pages/api/service/house-calls/index";
import { seedSales } from "../../prisma/seed/demo/sales";
import type { CatalogProduct } from "../../prisma/seed/demo/catalog";

const TZ = "America/New_York";
const pricer = { user: { id: "pat", email: "pat@example.com" } } as unknown as Session;
const NO_DISCOUNT = { holds: {} };

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  handler: AnyHandler,
  method: string,
  opts: { query?: Record<string, string>; body?: unknown; session?: Session | null } = {},
) {
  let status = 200;
  let payload: unknown;
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
  const req = {
    method,
    query: opts.query ?? {},
    body: opts.body ?? {},
    cookies: {},
    headers: {},
  } as unknown as NextApiRequest;
  await handler(req, res as unknown as NextApiResponse, opts.session ?? pricer, NO_DISCOUNT);
  return { status, body: payload as Body };
}

/** Through the real gate, signed in as `who`. */
async function asStaff(route: AnyHandler, who: string, method: string, query = {}, body = {}) {
  const session = { user: { id: who, email: `${who}@example.com` } };
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  let status = 200;
  let payload: unknown;
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
    { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return { status, body: payload as Body };
}

async function makeStaff(who: string, roleKey: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId: who,
      email: `${who}@example.com`,
      displayName: who,
      role: roleKey as never,
      roleId: role.id,
    },
  });
}

let today: string;
let store: { id: number; name: string };
let seq = 0;

async function product(
  baseRetail: number | null,
  extra: Prisma.ProductUncheckedCreateInput | object = {},
) {
  seq += 1;
  const vendor = await prisma.vendor.upsert({
    where: { name: "Harbor Works" },
    update: {},
    create: { name: "Harbor Works", pricingModel: "FLAT" },
  });
  const department = await prisma.department.upsert({
    where: { name: "Living" },
    update: {},
    create: { name: "Living" },
  });
  const category = await prisma.category.upsert({
    where: { name_departmentId: { name: "Sofas", departmentId: department.id } },
    update: {},
    create: { name: "Sofas", departmentId: department.id },
  });
  return prisma.product.create({
    data: {
      productNumber: `SOFA-${seq}`,
      name: `Sofa ${seq}`,
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseRetail,
      ...extra,
    },
  });
}

/** A sale written straight to the table: for days a route would refuse (the past). */
async function saleOn(
  startsOn: string,
  endsOn: string,
  items: { productId: number; salePrice: number }[],
  extra: { endedEarlyAt?: Date; endedEarlyBy?: string; name?: string } = {},
) {
  return prisma.sale.create({
    data: {
      name: extra.name ?? `Sale ${startsOn}`,
      startsOn: new Date(`${startsOn}T00:00:00.000Z`),
      endsOn: new Date(`${endsOn}T00:00:00.000Z`),
      createdBy: "test",
      endedEarlyAt: extra.endedEarlyAt ?? null,
      endedEarlyBy: extra.endedEarlyBy ?? null,
      items: { create: items },
    },
  });
}

const schedule = (body: object) => call(salesHandler, "POST", { body });

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: TZ },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE" },
  });
  today = await saleToday();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("one sale price per product per day", () => {
  it("refuses a product already in a sale on an overlapping day, and allows the next days", async () => {
    const sofa = await product(1000);
    const first = await schedule({
      name: "Fall Event",
      startsOn: today,
      endsOn: addDays(today, 5),
      items: [{ productId: sofa.id, salePrice: 800 }],
    });
    expect(first.status).toBe(201);

    const clash = await schedule({
      name: "Weekend",
      startsOn: addDays(today, 5),
      endsOn: addDays(today, 8),
      items: [{ productId: sofa.id, salePrice: 750 }],
    });
    expect(clash.status).toBe(400);
    expect(clash.body.error).toMatch(/already in the sale "Fall Event"/);
    expect(await prisma.sale.count()).toBe(1);

    const after = await schedule({
      name: "Weekend",
      startsOn: addDays(today, 6),
      endsOn: addDays(today, 8),
      items: [{ productId: sofa.id, salePrice: 750 }],
    });
    expect(after.status).toBe(201);
  });

  it("refuses moving a sale's dates onto another sale's days", async () => {
    const sofa = await product(1000);
    await schedule({
      name: "A",
      startsOn: addDays(today, 1),
      endsOn: addDays(today, 3),
      items: [{ productId: sofa.id, salePrice: 900 }],
    });
    const b = await schedule({
      name: "B",
      startsOn: addDays(today, 10),
      endsOn: addDays(today, 12),
      items: [{ productId: sofa.id, salePrice: 900 }],
    });
    const moved = await call(saleHandler, "PATCH", {
      query: { id: String(b.body.id) },
      body: { startsOn: addDays(today, 2), endsOn: addDays(today, 12) },
    });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toMatch(/already in the sale "A"/);
  });

  it("never counts a sale against itself: an upcoming sale's own products don't block its changes", async () => {
    const sofa = await product(1000);
    const res = await schedule({
      name: "Spring",
      startsOn: addDays(today, 3),
      endsOn: addDays(today, 5),
      items: [{ productId: sofa.id, salePrice: 900 }],
    });
    expect(res.status).toBe(201);
    const id = String(res.body.id);

    // Only the dates move: the sale's own sofa is checked against the new days.
    const moved = await call(saleHandler, "PATCH", {
      query: { id },
      body: { startsOn: addDays(today, 4), endsOn: addDays(today, 7) },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ startsOn: addDays(today, 4), endsOn: addDays(today, 7) });

    // The same product at a new price.
    const repriced = await call(saleHandler, "PATCH", {
      query: { id },
      body: { items: [{ productId: sofa.id, salePrice: 850 }] },
    });
    expect(repriced.status).toBe(200);
    expect(repriced.body.items).toMatchObject([{ productId: sofa.id, salePrice: 850 }]);

    // The editor's preview of its own sale: the sofa is priced, not "already in" itself.
    const preview = (saleId?: string) =>
      call(previewHandler, "POST", {
        body: {
          selection: { productIds: [sofa.id] },
          pricing: { kind: "AMOUNT", amount: 800 },
          startsOn: addDays(today, 4),
          endsOn: addDays(today, 7),
          ...(saleId !== undefined && { saleId }),
        },
      });
    const own = await preview(id);
    expect(own.status).toBe(200);
    expect(own.body.rows).toMatchObject([{ productId: sofa.id, salePrice: 800, skipped: null }]);
    // Previewed for a new sale instead, the same sofa is in "Spring" on those days.
    const fresh = await preview();
    expect(fresh.body.rows).toMatchObject([{ skipped: "OVERLAPS", overlaps: { name: "Spring" } }]);
  });

  it("lets only one of two sales written at once carry the product", async () => {
    const sofa = await product(1000);
    const fields = (name: string) => ({
      name,
      startsOn: today,
      endsOn: addDays(today, 3),
      note: null,
    });
    const results = await Promise.allSettled([
      createSale(fields("One"), [{ productId: sofa.id, salePrice: 800 }], "a"),
      createSale(fields("Two"), [{ productId: sofa.id, salePrice: 700 }], "b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.saleItem.count({ where: { productId: sofa.id } })).toBe(1);
  });

  it("waits on the product's row: a sale written while another holds it sees that one", async () => {
    const sofa = await product(1000);
    const holder = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 1 }),
    });
    let run: Promise<unknown> | undefined;
    try {
      await holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${sofa.id} FOR UPDATE`;
          run = createSale(
            { name: "Second", startsOn: today, endsOn: addDays(today, 2), note: null },
            [{ productId: sofa.id, salePrice: 700 }],
            "b",
          );
          run.catch(() => undefined);
          // Until the other write waits on the row, then schedule the product here.
          let waited = false;
          for (let i = 0; i < 200 && !waited; i++) {
            await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text AS cleared`;
            const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
            waited = n > 0;
            if (!waited) await new Promise((r) => setTimeout(r, 50));
          }
          if (!waited) throw new Error("The second sale never waited on the product's row.");
          await tx.sale.create({
            data: {
              name: "First",
              startsOn: new Date(`${today}T00:00:00.000Z`),
              endsOn: new Date(`${addDays(today, 1)}T00:00:00.000Z`),
              createdBy: "a",
              items: { create: [{ productId: sofa.id, salePrice: 800 }] },
            },
          });
        },
        { maxWait: 10000, timeout: 30000 },
      );
    } finally {
      await holder.$disconnect();
    }
    await expect(run).rejects.toThrow(/already in the sale "First"/);
    expect(await prisma.sale.findMany({ select: { name: true } })).toEqual([{ name: "First" }]);
  });
});

describe("the resolver decides on the store's day", () => {
  // America/New_York is UTC-5 in late November: its day starts at 05:00Z.
  const at = (iso: string) => saleToday(new Date(iso));

  it("applies from the first day's start to the last day's end, in the store's time zone", async () => {
    const sofa = await product(1000);
    await saleOn("2026-11-20", "2026-11-22", [{ productId: sofa.id, salePrice: 800 }]);
    const price = async (iso: string) =>
      (await loadActiveSalePrices([sofa.id], await at(iso), prisma)).get(sofa.id)?.salePrice ??
      null;
    expect(await price("2026-11-20T04:59:00Z")).toBeNull(); // 23:59 the evening before
    expect(await price("2026-11-20T05:00:00Z")).toBe(800); // midnight, first day
    expect(await price("2026-11-23T04:59:00Z")).toBe(800); // 23:59, last day
    expect(await price("2026-11-23T05:00:00Z")).toBeNull(); // the day after
  });

  it("stops at once when the sale is ended early", async () => {
    const sofa = await product(1000);
    await saleOn("2026-11-20", "2026-11-22", [{ productId: sofa.id, salePrice: 800 }], {
      endedEarlyAt: new Date("2026-11-21T15:00:00Z"),
      endedEarlyBy: "pat",
    });
    expect(
      (await loadActiveSalePrices([sofa.id], "2026-11-21", prisma)).get(sofa.id),
    ).toBeUndefined();
  });
});

describe("every reader answers the sale price", () => {
  async function onSale() {
    const sofa = await product(1000);
    await prisma.upc.create({ data: { upc: "0123456789012", productId: sofa.id } });
    const res = await schedule({
      name: "Fall Event",
      startsOn: today,
      endsOn: addDays(today, 6),
      items: [{ productId: sofa.id, salePrice: 800 }],
    });
    expect(res.status).toBe(201);
    return { sofa, saleId: res.body.id as number };
  }

  it("product search and the scan lookup answer it, with the regular price beside it", async () => {
    await makeStaff("mia", "MANAGER");
    const { sofa } = await onSale();
    const plain = await product(500);

    const search = await asStaff(productsRoute, "mia", "GET", { search: "Sofa", limit: "10" });
    expect(search.status).toBe(200);
    const byId = new Map(search.body.products.map((p: Body) => [p.id, p]));
    expect(byId.get(sofa.id)).toMatchObject({
      baseRetail: 800,
      regularRetail: 1000,
      onSale: true,
      saleEndsOn: addDays(today, 6),
    });
    expect(byId.get(plain.id)).toMatchObject({
      baseRetail: 500,
      regularRetail: 500,
      onSale: false,
      saleEndsOn: null,
    });

    for (const identifier of ["0123456789012", sofa.productNumber]) {
      const found = await asStaff(findRoute, "mia", "GET", { identifier });
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ id: sofa.id, baseRetail: 800, regularRetail: 1000 });
    }
  });

  it("a register sale at the sale price needs no manager, and records it as the list price", async () => {
    const { sofa } = await onSale();
    // The shipped default: staff may discount 0% on their own.
    const res = await call(createFromCart, "POST", {
      body: {
        storeLocation: store.name,
        items: [{ productId: sofa.id, quantity: 1, unitPrice: 800, discounts: [] }],
      },
    });
    expect(res.status).toBe(201);
    const line = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: res.body.id },
    });
    expect([Number(line.listPrice), Number(line.netPrice)]).toEqual([800, 800]);
  });

  it("measures a further discount from the sale price", async () => {
    const { sofa } = await onSale();
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { discountLimitPercent: 10 },
    });
    invalidateAppSettingsCache();
    const ring = (percent: number) =>
      call(createFromCart, "POST", {
        body: {
          storeLocation: store.name,
          items: [
            {
              productId: sofa.id,
              quantity: 1,
              unitPrice: 800,
              discounts: [{ type: "PERCENT", value: percent }],
            },
          ],
        },
      });
    // 10% off $800 is 10%, not the 28% it would be off the regular $1,000.
    expect((await ring(10)).status).toBe(201);
    const over = await ring(11);
    expect(over.status).toBe(403);
    expect(over.body).toMatchObject({ percent: 11, limit: 10 });
  });

  it("a duplicated order takes today's sale price", async () => {
    const sofa = await product(1000);
    const sold = await call(createFromCart, "POST", {
      body: {
        storeLocation: store.name,
        items: [{ productId: sofa.id, quantity: 1, unitPrice: 1000, discounts: [] }],
      },
    });
    expect(sold.status).toBe(201);
    await schedule({
      name: "Fall Event",
      startsOn: today,
      endsOn: today,
      items: [{ productId: sofa.id, salePrice: 850 }],
    });
    const copy = await call(duplicateHandler, "POST", { query: { id: String(sold.body.id) } });
    expect(copy.status).toBe(201);
    const line = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: copy.body.id },
    });
    expect([Number(line.listPrice), Number(line.netPrice)]).toEqual([850, 850]);
    // The original line keeps the price it was sold at.
    const original = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: sold.body.id },
    });
    expect(Number(original.netPrice)).toBe(1000);
  });
});

describe("a house call books its service at today's price", () => {
  it("writes the house-call line at the sale price while the service is on sale", async () => {
    await makeStaff("mia", "MANAGER");
    const visit = await product(250, {
      productNumber: "HC-VISIT",
      name: "Design visit",
      serviceType: "HOUSE_CALL",
    });
    const customer = await prisma.customer.create({
      data: { firstName: "Ana", lastName: "Reyes" },
    });
    const sale = await schedule({
      name: "Design Days",
      startsOn: today,
      endsOn: addDays(today, 2),
      items: [{ productId: visit.id, salePrice: 150 }],
    });
    expect(sale.status).toBe(201);

    const book = () =>
      asStaff(houseCallsRoute, "mia", "POST", {}, { customerId: String(customer.id) });
    const during = await book();
    expect(during.status).toBe(201);
    const line = await prisma.orderLineItem.findFirstOrThrow({
      where: { productId: visit.id },
      orderBy: { id: "desc" },
    });
    expect([Number(line.netPrice), Number(line.listPrice)]).toEqual([150, 150]);

    // Ended early: the next booking is at the regular price again.
    await call(endHandler, "POST", { query: { id: String(sale.body.id) } });
    expect((await book()).status).toBe(201);
    const after = await prisma.orderLineItem.findFirstOrThrow({
      where: { productId: visit.id },
      orderBy: { id: "desc" },
    });
    expect([Number(after.netPrice), Number(after.listPrice)]).toEqual([250, 250]);
  });
});

describe("tags during a sale", () => {
  const SALE_TAG = {
    context: "SALE",
    zplTemplate: "^XA^FD{{baseRetail}}|{{wasPrice}}|{{saving}}|{{saleEnds}}^FS^XZ",
    photoDots: null,
  };
  const PRICE_TAG = {
    context: "PRODUCT",
    zplTemplate: "^XA^FD{{baseRetail}}^FS^XZ",
    photoDots: null,
  };

  it("a SALE tag prints the sale price, the regular as was, and the last day; a PRODUCT tag the sale price", async () => {
    const sofa = await product(1000, { wasPrice: 1500 });
    const res = await schedule({
      name: "Fall Event",
      startsOn: today,
      endsOn: "2099-01-31",
      items: [{ productId: sofa.id, salePrice: 800 }],
    });
    expect(await renderProductTag(sofa.id, SALE_TAG)).toBe(
      "^XA^FD800.00|1000.00|200.00|Jan 31, 2099^FS^XZ",
    );
    expect(await renderProductTag(sofa.id, PRICE_TAG)).toBe("^XA^FD800.00^FS^XZ");

    // Ended early: the regular price, and the sale tag is the product's own markdown again.
    await call(endHandler, "POST", { query: { id: String(res.body.id) } });
    expect(await renderProductTag(sofa.id, PRICE_TAG)).toBe("^XA^FD1000.00^FS^XZ");
    expect(await renderProductTag(sofa.id, SALE_TAG)).toBe("^XA^FD1000.00|1500.00|500.00|^FS^XZ");
  });

  it("prints a batch of sale tags when asked for that kind", async () => {
    let bytes = "";
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        bytes += chunk.toString();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as net.AddressInfo;
      await prisma.printer.create({
        data: {
          name: "Floor Zebra",
          ipAddress: "127.0.0.1",
          port,
          tagType: "PRODUCT_TAG",
          store: store.name,
          supportedSizes: ["4x6"],
          currentSize: "4x6",
        },
      });
      await prisma.labelTemplate.create({
        data: {
          name: "Sale tag",
          context: "SALE",
          tagSize: "4x6",
          zplTemplate: SALE_TAG.zplTemplate,
        },
      });
      const a = await product(1000);
      const b = await product(400);
      await schedule({
        name: "Fall Event",
        startsOn: today,
        endsOn: "2099-01-31",
        items: [
          { productId: a.id, salePrice: 800 },
          { productId: b.id, salePrice: 300 },
        ],
      });
      const bogus = await call(batchHandler, "POST", {
        body: { kind: "CLEARANCE", items: [{ productId: a.id }] },
      });
      expect(bogus.status).toBe(400);

      const res = await call(batchHandler, "POST", {
        body: {
          kind: "SALE",
          storeLocationId: store.id,
          items: [{ productId: a.id }, { productId: b.id, copies: 2 }],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("2/2 labels printed");
      expect(res.body.results[0]).toMatchObject({
        success: true,
        printer: "Floor Zebra",
        template: "Sale tag",
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(bytes.match(/\^FD800\.00\|1000\.00\|200\.00\|Jan 31, 2099/g)).toHaveLength(1);
      expect(bytes.match(/\^FD300\.00\|400\.00\|100\.00\|Jan 31, 2099/g)).toHaveLength(2);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("what may change, and when", () => {
  it("before it starts: everything changes, and it can be deleted", async () => {
    const sofa = await product(1000);
    const chair = await product(300);
    const res = await schedule({
      name: "Spring",
      startsOn: addDays(today, 3),
      endsOn: addDays(today, 5),
      items: [{ productId: sofa.id, salePrice: 900 }],
    });
    const id = String(res.body.id);
    const changed = await call(saleHandler, "PATCH", {
      query: { id },
      body: {
        name: "Spring Event",
        startsOn: addDays(today, 4),
        endsOn: addDays(today, 6),
        items: [{ productId: chair.id, salePrice: 250 }],
      },
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      name: "Spring Event",
      status: "UPCOMING",
      startsOn: addDays(today, 4),
      items: [{ productId: chair.id, salePrice: 250, regularPrice: 300 }],
    });
    expect((await call(endHandler, "POST", { query: { id } })).status).toBe(400);
    expect((await call(saleHandler, "DELETE", { query: { id } })).status).toBe(200);
    expect(await prisma.saleItem.count()).toBe(0);
  });

  it("once on: name and note change, products and dates don't, it ends early and can't be deleted", async () => {
    const sofa = await product(1000);
    const res = await schedule({
      name: "Now",
      startsOn: today,
      endsOn: addDays(today, 5),
      items: [{ productId: sofa.id, salePrice: 900 }],
    });
    const id = String(res.body.id);
    const items = await call(saleHandler, "PATCH", {
      query: { id },
      body: { items: [{ productId: sofa.id, salePrice: 850 }] },
    });
    expect(items.status).toBe(400);
    expect(items.body.error).toMatch(/started/);
    const dates = await call(saleHandler, "PATCH", {
      query: { id },
      body: { startsOn: today, endsOn: addDays(today, 9) },
    });
    expect(dates.status).toBe(400);
    expect(
      (await call(saleHandler, "PATCH", { query: { id }, body: { note: "Floor only" } })).status,
    ).toBe(200);
    expect((await call(saleHandler, "DELETE", { query: { id } })).status).toBe(400);

    const ended = await call(endHandler, "POST", { query: { id } });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ status: "ENDED", endedEarlyBy: "pat@example.com" });
    // The rows stay: the record of what was charged.
    expect(await prisma.saleItem.count({ where: { saleId: Number(id) } })).toBe(1);
    expect((await call(endHandler, "POST", { query: { id } })).status).toBe(400);
    expect((await call(saleHandler, "DELETE", { query: { id } })).status).toBe(400);
  });

  it("refuses a sale starting before today, and a sale price not below the regular", async () => {
    const sofa = await product(1000);
    const past = await schedule({ name: "Past", startsOn: addDays(today, -1), endsOn: today });
    expect(past.status).toBe(400);
    const notBelow = await schedule({
      name: "Odd",
      startsOn: today,
      endsOn: today,
      items: [{ productId: sofa.id, salePrice: 1000 }],
    });
    expect(notBelow.status).toBe(400);
    expect(notBelow.body.error).toMatch(/must be below its regular price/);
    expect(await prisma.sale.count()).toBe(0);
  });

  it("is open to pricing staff only", async () => {
    await makeStaff("dana", "DESIGNER");
    await makeStaff("mia", "MANAGER");
    expect((await asStaff(salesRoute, "dana", "GET")).status).toBe(403);
    expect((await asStaff(salesRoute, "mia", "GET")).status).toBe(200);
  });
});

describe("the preview", () => {
  it("prices a selection by a percent off and says why any is left out", async () => {
    const sofa = await product(1000);
    const cheap = await product(0.8);
    const none = await product(null);
    const busy = await product(500);
    await schedule({
      name: "Other",
      startsOn: today,
      endsOn: addDays(today, 3),
      items: [{ productId: busy.id, salePrice: 400 }],
    });
    const res = await call(previewHandler, "POST", {
      body: {
        selection: { productIds: [sofa.id, cheap.id, none.id, busy.id] },
        pricing: { kind: "PERCENT_OFF", percent: 50, rounding: "WHOLE_NEAREST" },
        startsOn: addDays(today, 2),
        endsOn: addDays(today, 4),
      },
    });
    expect(res.status).toBe(200);
    const rows = new Map(res.body.rows.map((r: Body) => [r.productId, r]));
    expect(rows.get(sofa.id)).toMatchObject({ salePrice: 500, skipped: null });
    expect(rows.get(cheap.id)).toMatchObject({ skipped: "ROUNDS_TO_ZERO" });
    expect(rows.get(none.id)).toMatchObject({ skipped: "NO_RETAIL" });
    expect(rows.get(busy.id)).toMatchObject({ skipped: "OVERLAPS", overlaps: { name: "Other" } });
    expect(res.body).toMatchObject({ toSave: 1, rounding: "WHOLE_NEAREST" });
  });
});

describe("tags to change today", () => {
  it("lists sale tags for sales starting today and regular tags for sales just ended", async () => {
    const starting = await product(1000);
    const endedYesterday = await product(600);
    const endedEarly = await product(700);
    const longOver = await product(800);
    const still = await product(900);
    await schedule({
      name: "Starts Today",
      startsOn: today,
      endsOn: addDays(today, 2),
      items: [{ productId: starting.id, salePrice: 800 }],
    });
    await saleOn(
      addDays(today, -5),
      addDays(today, -1),
      [{ productId: endedYesterday.id, salePrice: 500 }],
      {
        name: "Ended Yesterday",
      },
    );
    await saleOn(
      addDays(today, -5),
      addDays(today, 5),
      [{ productId: endedEarly.id, salePrice: 600 }],
      {
        name: "Ended Early",
        endedEarlyAt: new Date(),
        endedEarlyBy: "pat",
      },
    );
    await saleOn(addDays(today, -9), addDays(today, -3), [
      { productId: longOver.id, salePrice: 700 },
    ]);
    await saleOn(addDays(today, -1), addDays(today, 5), [{ productId: still.id, salePrice: 800 }]);

    const res = await call(tagsHandler, "GET");
    expect(res.status).toBe(200);
    expect(res.body.today).toBe(today);
    expect(res.body.saleTags).toEqual([
      expect.objectContaining({
        productId: starting.id,
        price: 800,
        regularPrice: 1000,
        saleName: "Starts Today",
      }),
    ]);
    expect(res.body.productTags.map((t: Body) => [t.productId, t.price, t.saleName])).toEqual([
      [endedYesterday.id, 600, "Ended Yesterday"],
      [endedEarly.id, 700, "Ended Early"],
    ]);
  });

  it("gives a product whose old sale ended and whose new one starts today the new sale tag", async () => {
    const sofa = await product(1000);
    await saleOn(addDays(today, -5), addDays(today, -1), [{ productId: sofa.id, salePrice: 900 }]);
    await schedule({
      name: "Next",
      startsOn: today,
      endsOn: today,
      items: [{ productId: sofa.id, salePrice: 700 }],
    });
    const list = await tagsToChange(today);
    expect(list.saleTags.map((t) => [t.productId, t.price, t.saleName])).toEqual([
      [sofa.id, 700, "Next"],
    ]);
    expect(list.productTags).toEqual([]);
  });
});

describe("the audit trail", () => {
  it("records each change in the prices group, against the sale", async () => {
    const sofa = await product(1000);
    const upcoming = await schedule({
      name: "Later",
      startsOn: addDays(today, 2),
      endsOn: addDays(today, 3),
      items: [{ productId: sofa.id, salePrice: 900 }],
    });
    await call(saleHandler, "PATCH", {
      query: { id: String(upcoming.body.id) },
      body: { name: "Later Event" },
    });
    await call(saleHandler, "DELETE", { query: { id: String(upcoming.body.id) } });
    const now = await schedule({ name: "Now", startsOn: today, endsOn: today });
    await call(endHandler, "POST", { query: { id: String(now.body.id) } });

    const entries = await prisma.auditEntry.findMany({ orderBy: { id: "asc" } });
    expect(entries.map((e) => [e.event, e.actor, e.targetType])).toEqual([
      ["SALE_SCHEDULED", "pat@example.com", "sale"],
      ["SALE_CHANGED", "pat@example.com", "sale"],
      ["SALE_DELETED", "pat@example.com", "sale"],
      ["SALE_SCHEDULED", "pat@example.com", "sale"],
      ["SALE_ENDED", "pat@example.com", "sale"],
    ]);
    expect(entries[0].summary).toBe(
      `Sale "Later" scheduled for ${addDays(today, 2)} to ${addDays(today, 3)}: 1 product`,
    );
    expect(entries[1].details).toMatchObject({ changed: ["name"] });
  });

  it("writes nothing when a change is refused", async () => {
    const sofa = await product(1000);
    await schedule({
      name: "A",
      startsOn: today,
      endsOn: today,
      items: [{ productId: sofa.id, salePrice: 900 }],
    });
    await schedule({
      name: "B",
      startsOn: today,
      endsOn: today,
      items: [{ productId: sofa.id, salePrice: 800 }],
    });
    expect(await prisma.auditEntry.count({ where: { event: "SALE_SCHEDULED" } })).toBe(1);
    expect((await getAppSettings()).timezone).toBe(TZ);
  });
});

describe("the demo seed", () => {
  it("schedules one ended, one current and one upcoming sale through the screen's code", async () => {
    const made = [];
    for (let i = 0; i < 17; i++) made.push(await product(100 + i * 10));
    const catalog = made.map((p) => ({
      id: p.id,
      baseRetail: Number(p.baseRetail),
    })) as unknown as CatalogProduct[];
    expect(await seedSales(prisma, catalog, new Date())).toEqual({ sales: 3, items: 12 });
    const sales = await listSales(today);
    expect(sales.map((s) => [s.status, s.itemCount]).sort()).toEqual([
      ["ENDED", 4],
      ["ON", 4],
      ["UPCOMING", 4],
    ]);
    // The first five are the markdown's and the price lock's: left alone.
    expect(
      await prisma.saleItem.count({
        where: { productId: { in: made.slice(0, 5).map((p) => p.id) } },
      }),
    ).toBe(0);
    expect(await prisma.auditEntry.count({ where: { event: "SALE_SCHEDULED" } })).toBe(3);
  });
});
