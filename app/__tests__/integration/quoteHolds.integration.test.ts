// /app/__tests__/integration/quoteHolds.integration.test.ts
//
// GAP-16 and GAP-21: what a sale commits.
//
// Before: every order started as a quote and committed every line's stock the
// moment it was written, with no end. A quote nobody came back for kept its
// sofa off the floor indefinitely, and there was no way to hold a piece for a
// customer on purpose.
//
// Owner, 2026-11-01: "we can put it on a quote and part of the quote if it is
// floor stock can be hold until x date, and again a config would set the max
// allowed". So a quote commits only the floor-stock lines it holds, through
// their day; an order commits everything; the store sets the longest hold.
//
// And once a register sale commits at its first payment rather than when it
// is written, a product in a category that keeps no stock must not raise a
// shortfall: it has no stock. A made-to-order line is an item like any other
// (owner, 2026-11-02), short until its piece arrives.
//
// Real routes, real database; next-auth's session is the only mock.

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
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { addDays, businessDayKey } from "@/lib/reports/businessDay";
import { onPaymentReceived } from "@/lib/paymentService";
import { promoteQuoteToOrder } from "@/lib/sales/quoteHolds";
import { markHandedOver } from "@/lib/fulfilment/handover";
import { getOnHoldReport, onHoldCsv } from "@/lib/reports/onHold";
import { handler as createFromCart } from "@/pages/api/sales/orders/create-from-cart";
import { handler as orderRoute } from "@/pages/api/sales/orders/[id]";
import { handler as lineRoute } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";
import { handler as policyRoute } from "@/pages/api/sales/quote-hold-policy";
import { handler as onHoldRoute } from "@/pages/api/reports/on-hold";
import { run as expireHolds } from "@/pages/api/automations/expire-quote-holds";
import archiveRoute from "@/pages/api/sales/pipeline/[id]";
import bulkArchiveRoute from "@/pages/api/sales/pipeline/bulk-archive";
import settingsRoute from "@/pages/api/admin/settings/index";
import { stockAt } from "../helpers/stock";

const designer = { user: { email: "designer@example.com" } } as unknown as Session;

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
    send(payload: unknown) {
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

function request(method: string, query: Record<string, string>, body?: unknown): NextApiRequest {
  return { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest;
}

const today = () => businessDayKey(new Date(), "UTC");

/** A store, a stocked sofa (2 on hand) and chair (none), and a service in a category that keeps no stock. */
async function world(opts: { maxDays?: number } = {}) {
  if (opts.maxDays !== undefined) {
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { quoteHoldMaxDays: opts.maxDays },
    });
    invalidateAppSettingsCache();
  }
  const store = await prisma.storeLocation.create({
    data: { name: "Test Store", code: "TS", type: "STORE" },
  });
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Furniture" } });
  const sofas = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  const services = await prisma.category.create({
    data: { name: "Services", departmentId: department.id, trackInventory: false },
  });
  const product = (productNumber: string, categoryId: number, baseRetail: number) =>
    prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId,
        baseRetail,
      },
    });
  const sofa = await product("SOFA-1", sofas.id, 1000);
  const chair = await product("CHAIR-1", sofas.id, 400);
  const assembly = await product("ASSEMBLY", services.id, 50);
  await stockAt({ productId: sofa.id, storeLocationId: store.id, quantity: 2 });
  return { store, sofa, chair, assembly };
}

type World = Awaited<ReturnType<typeof world>>;

interface CartLine {
  productId?: number;
  quantity?: number;
  unitPrice: number;
  source?: string;
  holdUntil?: string | null;
  type?: "PRODUCT" | "CONFIGURED" | "CUSTOM";
  name?: string;
  vendor?: string;
  isReturn?: boolean;
}

async function ring(w: World, items: CartLine[]) {
  const res = makeRes();
  await createFromCart(
    request(
      "POST",
      {},
      {
        storeLocation: w.store.name,
        items: items.map((i) => ({ quantity: 1, ...i })),
      },
    ),
    res,
    designer,
    { holds: {} },
  );
  return res;
}

async function committed(orderId: number, productId?: number): Promise<number> {
  const sum = await prisma.inventoryPosition.aggregate({
    where: { salesOrderId: orderId, ...(productId ? { productId } : {}) },
    _sum: { quantity: true },
  });
  return Number(sum._sum.quantity ?? 0);
}

async function free(productId: number): Promise<number> {
  const sum = await prisma.inventoryPosition.aggregate({
    where: { productId, salesOrderId: null },
    _sum: { quantity: true },
  });
  return Number(sum._sum.quantity ?? 0);
}

async function lineOf(orderId: number, productId: number) {
  return prisma.orderLineItem.findFirstOrThrow({ where: { salesOrderId: orderId, productId } });
}

async function hold(orderId: number, lineItemId: number, holdUntil: string | null) {
  const res = makeRes();
  await lineRoute(
    request(
      "PUT",
      { id: String(orderId), lineItemId: String(lineItemId) },
      { action: "hold", holdUntil },
    ),
    res,
    designer,
  );
  return res;
}

async function setStatus(orderId: number, status: string) {
  const res = makeRes();
  await orderRoute(request("PUT", { id: String(orderId) }, { status }), res, designer);
  return res;
}

async function staff(key: string, roleKey: string) {
  await prisma.user.create({ data: { id: key, email: `${key}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId: key,
      email: `${key}@example.com`,
      displayName: key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: roleKey as any,
      roleId: role.id,
    },
  });
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: key, email: `${key}@example.com` },
  });
}

/** Make a hold's last day yesterday, as if the days had passed. */
async function ageHold(lineItemId: number) {
  await prisma.orderLineItem.update({
    where: { id: lineItemId },
    data: { holdUntil: new Date(`${addDays(today(), -1)}T00:00:00.000Z`) },
  });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a quote commits only the stock it holds", () => {
  it("a sale rung with no hold commits nothing until its first payment, then everything", async () => {
    const w = await world();
    const res = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000 }]);
    expect(res.statusCode).toBe(201);
    expect(await committed(res.body.id)).toBe(0);
    expect(await free(w.sofa.id)).toBe(2);

    await onPaymentReceived(res.body.id);

    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(order.status).toBe("ORDER");
    expect(await committed(res.body.id, w.sofa.id)).toBe(1);
    expect(await free(w.sofa.id)).toBe(1);
    expect(await prisma.inventoryException.count()).toBe(0);
  });

  it("a held line commits as soon as the quote is written; an unheld one beside it does not", async () => {
    const w = await world();
    await stockAt({ productId: w.chair.id, storeLocationId: w.store.id, quantity: 1 });
    const res = await ring(w, [
      { productId: w.sofa.id, unitPrice: 1000, source: "FLOOR", holdUntil: addDays(today(), 3) },
      { productId: w.chair.id, unitPrice: 400, source: "FLOOR" },
    ]);
    expect(res.statusCode).toBe(201);
    expect(await committed(res.body.id, w.sofa.id)).toBe(1);
    expect(await committed(res.body.id, w.chair.id)).toBe(0);
    const line = await lineOf(res.body.id, w.sofa.id);
    expect(line.holdUntil?.toISOString().slice(0, 10)).toBe(addDays(today(), 3));
  });

  it("refuses a hold the store doesn't allow, saying why, and writes nothing", async () => {
    const w = await world();
    const cases: [CartLine, RegExp][] = [
      [{ productId: w.sofa.id, unitPrice: 1000, holdUntil: addDays(today(), 4) }, /at most 3 days/],
      [{ productId: w.sofa.id, unitPrice: 1000, holdUntil: addDays(today(), -1) }, /before today/],
      [{ productId: w.sofa.id, unitPrice: 1000, holdUntil: "next week" }, /YYYY-MM-DD/],
      [
        { productId: w.sofa.id, unitPrice: 1000, source: "ORDER", holdUntil: today() },
        /special-order/,
      ],
      [{ productId: w.assembly.id, unitPrice: 50, holdUntil: today() }, /floor stock/],
      [
        {
          type: "CONFIGURED",
          productId: w.sofa.id,
          name: "Custom sofa",
          vendor: "V",
          unitPrice: 1500,
          holdUntil: today(),
        },
        /floor stock/,
      ],
      [
        { productId: w.sofa.id, unitPrice: 1000, isReturn: true, quantity: -1, holdUntil: today() },
        /return/,
      ],
    ];
    for (const [line, message] of cases) {
      const res = await ring(w, [line]);
      expect([res.statusCode, res.body.error]).toEqual([400, expect.stringMatching(message)]);
    }
    expect(await prisma.salesOrder.count()).toBe(0);
  });

  it("holds nothing at all when the store sets 0 days", async () => {
    const w = await world({ maxDays: 0 });
    const res = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000, holdUntil: today() }]);
    expect([res.statusCode, res.body.error]).toEqual([400, expect.stringMatching(/don't hold/)]);
  });

  it("follows the store's longest hold: 30 days admits a hold 30 days out", async () => {
    const w = await world({ maxDays: 30 });
    const res = await ring(w, [
      { productId: w.sofa.id, unitPrice: 1000, holdUntil: addDays(today(), 30) },
    ]);
    expect(res.statusCode).toBe(201);
    expect(await committed(res.body.id)).toBe(1);
  });
});

describe("staff hold, move and take off a quote line's hold", () => {
  it("holding a line commits it, and taking the hold off releases it, each logged", async () => {
    const w = await world();
    const res = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000, source: "FLOOR" }]);
    const line = await lineOf(res.body.id, w.sofa.id);

    const held = await hold(res.body.id, line.id, today());
    expect([held.statusCode, held.body.holdUntil]).toEqual([200, today()]);
    expect(await committed(res.body.id)).toBe(1);

    const moved = await hold(res.body.id, line.id, addDays(today(), 2));
    expect(moved.statusCode).toBe(200);
    expect(await committed(res.body.id)).toBe(1);

    const off = await hold(res.body.id, line.id, null);
    expect([off.statusCode, off.body.holdUntil]).toEqual([200, null]);
    expect(await committed(res.body.id)).toBe(0);
    expect(await free(w.sofa.id)).toBe(2);

    const log = await prisma.orderChangeLog.findMany({
      where: { salesOrderId: res.body.id, lineItemId: line.id },
      orderBy: { id: "asc" },
      select: { changeType: true, previousValue: true, newValue: true },
    });
    expect(log).toEqual([
      { changeType: "HOLD_SET", previousValue: null, newValue: today() },
      { changeType: "HOLD_SET", previousValue: today(), newValue: addDays(today(), 2) },
      { changeType: "HOLD_ENDED", previousValue: addDays(today(), 2), newValue: null },
    ]);
  });

  it("refuses a hold on an order, past the store's longest, or on a special order", async () => {
    const w = await world();
    const quote = await ring(w, [
      { productId: w.sofa.id, unitPrice: 1000, source: "FLOOR" },
      { productId: w.chair.id, unitPrice: 400, source: "ORDER" },
    ]);
    const sofaLine = await lineOf(quote.body.id, w.sofa.id);
    const chairLine = await lineOf(quote.body.id, w.chair.id);

    const tooLong = await hold(quote.body.id, sofaLine.id, addDays(today(), 4));
    expect([tooLong.statusCode, tooLong.body.error]).toEqual([
      400,
      expect.stringMatching(/at most 3 days/),
    ]);
    const special = await hold(quote.body.id, chairLine.id, today());
    expect([special.statusCode, special.body.error]).toEqual([
      409,
      expect.stringMatching(/special-order/),
    ]);

    await onPaymentReceived(quote.body.id);
    const onOrder = await hold(quote.body.id, sofaLine.id, today());
    expect([onOrder.statusCode, onOrder.body.error]).toEqual([
      409,
      expect.stringMatching(/Only a quote holds stock/),
    ]);
  });

  it("the order screen says which lines are held and which could be", async () => {
    const w = await world();
    const quote = await ring(w, [
      { productId: w.sofa.id, unitPrice: 1000, source: "FLOOR", holdUntil: today() },
      { productId: w.chair.id, unitPrice: 400, source: "ORDER" },
      { productId: w.assembly.id, unitPrice: 50 },
    ]);
    const res = makeRes();
    await orderRoute(request("GET", { id: String(quote.body.id) }), res, designer);
    const byProduct = Object.fromEntries(
      res.body.lineItems.map((l: { productId: number; holdUntil: string; holdable: boolean }) => [
        l.productId,
        [l.holdUntil, l.holdable],
      ]),
    );
    expect(byProduct).toEqual({
      [w.sofa.id]: [today(), true],
      [w.chair.id]: [null, false],
      [w.assembly.id]: [null, false],
    });
  });

  it("the screens are told today and the last day a hold may run to", async () => {
    await world({ maxDays: 5 });
    const res = makeRes();
    await policyRoute(request("GET", {}), res);
    expect(res.body).toEqual({ today: today(), maxDays: 5, latest: addDays(today(), 5) });
  });
});

describe("every way out of a quote commits as an order", () => {
  it("a status change to an order commits the unheld lines; back to a quote releases them", async () => {
    const w = await world();
    const quote = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000 }]);
    expect(await committed(quote.body.id)).toBe(0);

    const toOrder = await setStatus(quote.body.id, "ORDER");
    expect([toOrder.statusCode, toOrder.body.status]).toEqual([200, "ORDER"]);
    expect(await committed(quote.body.id)).toBe(1);

    const back = await setStatus(quote.body.id, "QUOTE");
    expect(back.body.status).toBe("QUOTE");
    expect(await committed(quote.body.id)).toBe(0);
  });

  it("handed over straight from a quote, its unheld line's stock leaves the books", async () => {
    const w = await world();
    const quote = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000 }]);

    const res = await setStatus(quote.body.id, "FULFILLED");
    expect(res.body.status).toBe("FULFILLED");
    expect(await committed(quote.body.id)).toBe(0);
    expect(await free(w.sofa.id)).toBe(1);
    const delivered = await prisma.stockMovement.aggregate({
      where: { productId: w.sofa.id, reason: "DELIVER" },
      _sum: { quantity: true },
    });
    expect(Number(delivered._sum.quantity)).toBe(1);
  });

  it("handed over by another path (a stop, a pickup) straight from a quote, the same", async () => {
    const w = await world();
    const quote = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000 }]);
    await prisma.$transaction((tx) =>
      markHandedOver(tx, {
        salesOrderId: quote.body.id,
        at: new Date(),
        method: "PICKUP",
        actor: "test",
      }),
    );
    expect(await committed(quote.body.id)).toBe(0);
    expect(await free(w.sofa.id)).toBe(1);
  });

  it("two payments arriving together promote the quote once", async () => {
    const w = await world();
    const quote = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000 }]);
    const promote = () => prisma.$transaction((tx) => promoteQuoteToOrder(tx, quote.body.id));
    const results = await Promise.all([promote(), promote()]);
    expect(results.sort()).toEqual([false, true]);
    expect(await committed(quote.body.id)).toBe(1);
  });
});

describe("a hold ends", () => {
  it("the day after its last day, the sweep puts the stock back on sale, once", async () => {
    const w = await world();
    const ends = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000, holdUntil: today() }]);
    const runs = await ring(w, [
      { productId: w.sofa.id, unitPrice: 1000, holdUntil: addDays(today(), 1) },
    ]);
    await ageHold((await lineOf(ends.body.id, w.sofa.id)).id);

    const res = makeRes();
    await expireHolds(request("POST", {}), res);
    expect(res.body).toEqual({ checked: 2, released: 1, units: 1 });
    expect(await committed(ends.body.id)).toBe(0);
    expect(await committed(runs.body.id)).toBe(1);

    const again = makeRes();
    await expireHolds(request("POST", {}), again);
    expect(again.body).toEqual({ checked: 1, released: 0, units: 0 });
  });

  it("a hold through today still holds", async () => {
    const w = await world();
    const quote = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000, holdUntil: today() }]);
    const res = makeRes();
    await expireHolds(request("POST", {}), res);
    expect(res.body.released).toBe(0);
    expect(await committed(quote.body.id)).toBe(1);
  });

  it("the sweep also releases a quote written before holds, which committed every line", async () => {
    const w = await world();
    const quote = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000 }]);
    // As create-from-cart used to: every quote line committed, no hold.
    await setStatus(quote.body.id, "ORDER");
    await prisma.salesOrder.update({ where: { id: quote.body.id }, data: { status: "QUOTE" } });
    expect(await committed(quote.body.id)).toBe(1);

    const res = makeRes();
    await expireHolds(request("POST", {}), res);
    expect(res.body).toEqual({ checked: 1, released: 1, units: 1 });
    expect(await free(w.sofa.id)).toBe(2);
  });

  it("a held line short of stock closes its shortfall once the hold ends", async () => {
    const w = await world();
    const quote = await ring(w, [{ productId: w.chair.id, unitPrice: 400, holdUntil: today() }]);
    const open = await prisma.inventoryException.findFirstOrThrow({
      where: { salesOrderId: quote.body.id },
    });
    expect([Number(open.shortfall), open.resolvedAt]).toEqual([1, null]);

    await hold(quote.body.id, (await lineOf(quote.body.id, w.chair.id)).id, null);

    const closed = await prisma.inventoryException.findUniqueOrThrow({ where: { id: open.id } });
    expect(closed.resolvedAt).not.toBeNull();
    expect(closed.resolutionNote).toMatch(/no longer commits/);
  });

  it("archiving a quote ends its holds; restoring it brings back the quote, not the holds", async () => {
    const w = await world();
    await staff("owner", "ADMIN");
    const quote = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000, holdUntil: today() }]);
    const archive = async (archived: boolean) => {
      const res = makeRes();
      await archiveRoute(
        request(
          "PATCH",
          { id: String(quote.body.id) },
          { archived, ...(archived ? { reason: "Customer Passed" } : {}) },
        ),
        res,
      );
      return res;
    };
    expect((await archive(true)).statusCode).toBe(200);
    expect(await committed(quote.body.id)).toBe(0);
    expect((await lineOf(quote.body.id, w.sofa.id)).holdUntil).toBeNull();

    expect((await archive(false)).statusCode).toBe(200);
    expect(await committed(quote.body.id)).toBe(0);
  });

  it("archiving quotes in bulk ends their holds too", async () => {
    const w = await world();
    await staff("owner", "ADMIN");
    const quote = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000, holdUntil: today() }]);
    const res = makeRes();
    await bulkArchiveRoute(
      request("POST", {}, { before: new Date(Date.now() + 86_400_000).toISOString() }),
      res,
    );
    expect(res.body).toEqual({ archived: 1 });
    expect(await committed(quote.body.id)).toBe(0);
  });
});

describe("what isn't stocked never raises a shortfall (GAP-21)", () => {
  it("a no-stock line commits nothing when paid; a made-to-order or stocked line with none is short", async () => {
    const w = await world();
    const sale = await ring(w, [
      {
        type: "CONFIGURED",
        productId: w.sofa.id,
        name: "Custom sofa",
        vendor: "V",
        unitPrice: 1500,
      },
      { productId: w.assembly.id, unitPrice: 50 },
      { productId: w.chair.id, unitPrice: 400 },
    ]);
    expect(sale.statusCode).toBe(201);
    const minted = await prisma.orderLineItem.findFirstOrThrow({
      where: { salesOrderId: sale.body.id, productName: "Custom sofa" },
      select: { productId: true, product: { select: { madeToOrder: true } } },
    });
    expect(minted.product?.madeToOrder).toBe(true);

    await onPaymentReceived(sale.body.id);

    const short = await prisma.inventoryException.findMany({
      where: { salesOrderId: sale.body.id },
      select: { productId: true },
      orderBy: { productId: "asc" },
    });
    expect(short.map((r) => r.productId)).toEqual(
      [w.chair.id, minted.productId as number].sort((a, b) => a - b),
    );
  });
});

describe("Reports › On hold", () => {
  it("lists open holds soonest first, with what each quote really holds and where", async () => {
    const w = await world();
    const customer = await prisma.customer.create({ data: { firstName: "Ada", lastName: "Lane" } });
    const later = await ring(w, [
      { productId: w.sofa.id, unitPrice: 1000, holdUntil: addDays(today(), 2) },
    ]);
    const sooner = await ring(w, [
      { productId: w.sofa.id, unitPrice: 1000, holdUntil: today() },
      { productId: w.chair.id, unitPrice: 400, holdUntil: today() },
    ]);
    await prisma.salesOrder.update({
      where: { id: sooner.body.id },
      data: { customerId: customer.id },
    });
    const ended = await ring(w, [{ productId: w.chair.id, unitPrice: 400, holdUntil: today() }]);
    await ageHold((await lineOf(ended.body.id, w.chair.id)).id);
    const ordered = await ring(w, [{ productId: w.sofa.id, unitPrice: 1000, holdUntil: today() }]);
    await onPaymentReceived(ordered.body.id);

    const rows = await getOnHoldReport(prisma, today());
    expect(
      rows.map((r) => [r.orderno, r.productName, r.held, r.quantity, r.daysLeft, r.customerName]),
    ).toEqual([
      [sooner.body.orderno, "SOFA-1", 1, 1, 0, "Ada Lane"],
      [sooner.body.orderno, "CHAIR-1", 0, 1, 0, "Ada Lane"],
      [later.body.orderno, "SOFA-1", 1, 1, 2, null],
    ]);
    expect(rows[0].places).toEqual([expect.stringMatching(/^Test Store \/ /)]);
    expect(onHoldCsv(rows).split("\n")[0]).toBe(
      "Held until,Days left,Quote,Customer,Salesperson,Store,Product,Part No,Held,Of,Where",
    );

    const res = makeRes();
    await onHoldRoute(request("GET", {}), res);
    expect([res.body.today, res.body.rows.length]).toEqual([today(), 3]);
  });
});

describe("the store's longest hold (Settings)", () => {
  it("is a whole number of days from 0 to 365, and the default is 3", async () => {
    await world();
    await staff("owner", "ADMIN");
    const put = async (body: unknown) => {
      const res = makeRes();
      await settingsRoute(request("PUT", {}, body), res);
      return res;
    };
    const row = await prisma.appSettings.findUniqueOrThrow({
      where: { organizationId: DEFAULT_ORG_ID },
    });
    expect(row.quoteHoldMaxDays).toBe(3);
    for (const bad of [-1, 366, 2.5, "3", null]) {
      const res = await put({ quoteHoldMaxDays: bad });
      expect([res.statusCode, res.body.error]).toEqual([
        400,
        expect.stringMatching(/0 \(quotes hold nothing\) to 365/),
      ]);
    }
    for (const good of [0, 30]) {
      const res = await put({ quoteHoldMaxDays: good });
      expect([res.statusCode, res.body.settings.quoteHoldMaxDays]).toEqual([200, good]);
    }
  });

  it("the database refuses a value outside 0-365", async () => {
    for (const bad of [-1, 366]) {
      await expect(
        prisma.appSettings.update({
          where: { organizationId: DEFAULT_ORG_ID },
          data: { quoteHoldMaxDays: bad },
        }),
      ).rejects.toThrow();
    }
  });
});
