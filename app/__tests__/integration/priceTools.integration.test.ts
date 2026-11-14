// __tests__/integration/priceTools.integration.test.ts
//
// GAP-06 routes against a real database; only the session readers are mocked,
// so each request signs in as a real staff member through the real gate.
//
//   - PATCH /api/products/[id]: retail and the price lock need "Change pricing"
//     when they change; the was price and everything else stay on "Edit catalog";
//   - the mass price change: list, preview, apply (stale refused, locked kept,
//     one batch, one audit entry), lock, the cap and the gate;
//   - the store's pricing settings, saved and merged, refused when wrong;
//   - a category's markup: kept by a PUT that doesn't send it, given on create,
//     gated, audited;
//   - the mass change's list strips cost without View cost, and its filter
//     options are open to pricing staff only;
//   - a vendor's markup: validated and audited;
//   - the configurator's per-style markup;
//   - what a mass change won't write: a price rounded to nothing, a was price
//     at or under the new retail; and that a retail stored past the cent
//     doesn't refuse a run that keeps it;
//   - cost × markup needs View cost, since its prices give cost back;
//   - the demo seed's markdown is recorded as a run from the screen is.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, getAppSettings, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { MASS_CHANGE_MAX_PRODUCTS } from "@/lib/pricing/massChangeShared";
import productRoute from "@/pages/api/products/[id]";
import listRoute from "@/pages/api/pricing/mass-change/index";
import previewRoute from "@/pages/api/pricing/mass-change/preview";
import applyRoute from "@/pages/api/pricing/mass-change/apply";
import lockRoute from "@/pages/api/pricing/mass-change/lock";
import settingsRoute from "@/pages/api/admin/settings/index";
import categoryRoute from "@/pages/api/categories/[id]";
import categoriesRoute from "@/pages/api/categories/index";
import optionsRoute from "@/pages/api/pricing/mass-change/options";
import vendorRoute from "@/pages/api/vendors/[id]";
import { handler as pricingProductsHandler } from "@/pages/api/pricing/products";
import { seedPriceChanges } from "../../prisma/seed/demo/priceChanges";
import type { CatalogProduct } from "../../prisma/seed/demo/catalog";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(
  route: Route,
  who: string | null,
  method: string,
  body: object = {},
  query: Record<string, string> = {},
) {
  const session = who ? { user: { id: who, email: `${who}@example.com` } } : null;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, body: payload as Record<string, any> };
}

async function makeStaff(who: string, roleKey: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: { userId: who, displayName: who, role: roleKey as never, roleId: role.id },
  });
}

/** Someone who may edit the catalog but not change pricing: no built-in role is (each with
 *  "Edit catalog" also has "Change pricing"), so a store's own role. */
async function makeCatalogOnlyStaff(who: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.create({
    data: {
      key: `CUSTOM_${who.toUpperCase()}`,
      name: who,
      isSystem: false,
      permissions: {
        create: ["catalog.read", "catalog.write"].map((permission) => ({ permission })),
      },
    },
  });
  invalidateRoleGrantCache();
  await prisma.staffMember.create({
    data: { userId: who, displayName: who, role: "DESIGNER", roleId: role.id },
  });
}

/** A store's own role holding exactly these keys. */
async function makeStaffHolding(who: string, permissions: string[]) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.create({
    data: {
      key: `CUSTOM_${who.toUpperCase()}`,
      name: who,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  invalidateRoleGrantCache();
  await prisma.staffMember.create({
    data: { userId: who, displayName: who, role: "DESIGNER", roleId: role.id },
  });
}

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "Harbor Works", defaultMarkup: 2 } });
  const other = await prisma.vendor.create({ data: { name: "Cedar Lane" } });
  const department = await prisma.department.create({ data: { name: "Living" } });
  const sofas = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, defaultMarkup: 3 },
  });
  const lamps = await prisma.category.create({
    data: { name: "Lamps", departmentId: department.id },
  });
  return { vendor, other, department, sofas, lamps };
}

let seq = 0;
async function product(
  w: Awaited<ReturnType<typeof world>>,
  opts: {
    vendorId?: number;
    categoryId?: number;
    baseCost?: number | null;
    baseRetail?: number | null;
    wasPrice?: number | null;
    priceLocked?: boolean;
    name?: string;
  } = {},
) {
  seq += 1;
  return prisma.product.create({
    data: {
      productNumber: `MC-${seq}`,
      name: opts.name ?? `Item ${seq}`,
      vendorId: opts.vendorId ?? w.vendor.id,
      departmentId: w.department.id,
      categoryId: opts.categoryId ?? w.sofas.id,
      baseCost: opts.baseCost === undefined ? 100 : opts.baseCost,
      baseRetail: opts.baseRetail === undefined ? 250 : opts.baseRetail,
      wasPrice: opts.wasPrice ?? null,
      priceLocked: opts.priceLocked ?? false,
    },
  });
}

const fresh = (id: number) => prisma.product.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({ data: { organizationId: DEFAULT_ORG_ID, appName: "Holt" } });
  invalidateAppSettingsCache();
  await makeStaff("boss", "ADMIN");
  await makeCatalogOnlyStaff("clerk");
  await makeStaff("till", "REGISTER");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("PATCH /api/products/[id]", () => {
  it("lets catalog-only staff save the form, resending an unchanged retail", async () => {
    const w = await world();
    const p = await product(w, { baseRetail: 250 });
    const res = await call(
      productRoute,
      "clerk",
      "PATCH",
      { name: "Renamed", baseRetail: "250" },
      {
        id: String(p.id),
      },
    );
    expect(res.status).toBe(200);
    expect((await fresh(p.id)).name).toBe("Renamed");
    expect(await prisma.productPriceChange.count()).toBe(0);
  });

  it("refuses catalog-only staff a retail change or a lock, and changes nothing", async () => {
    const w = await world();
    const p = await product(w, { baseRetail: 250 });
    const retail = await call(
      productRoute,
      "clerk",
      "PATCH",
      { name: "X", baseRetail: 199 },
      {
        id: String(p.id),
      },
    );
    expect(retail.status).toBe(403);
    const lock = await call(
      productRoute,
      "clerk",
      "PATCH",
      { priceLocked: true },
      {
        id: String(p.id),
      },
    );
    expect(lock.status).toBe(403);
    const after = await fresh(p.id);
    expect([after.name, Number(after.baseRetail), after.priceLocked]).toEqual([p.name, 250, false]);
  });

  it("lets catalog-only staff set a was price (the tag workflow), through the ledger", async () => {
    const w = await world();
    const p = await product(w, { baseRetail: 250 });
    const res = await call(productRoute, "clerk", "PATCH", { wasPrice: 300 }, { id: String(p.id) });
    expect(res.status).toBe(200);
    const [row] = await prisma.productPriceChange.findMany();
    expect([row.source, Number(row.toWas), Number(row.toRetail)]).toEqual(["MANUAL", 300, 250]);
  });

  it("lets pricing staff change a LOCKED product's retail by hand, recorded in the same save", async () => {
    const w = await world();
    const p = await product(w, { baseRetail: 250, priceLocked: true });
    const res = await call(
      productRoute,
      "boss",
      "PATCH",
      { baseRetail: "199.99" },
      {
        id: String(p.id),
      },
    );
    expect(res.status).toBe(200);
    expect(Number((await fresh(p.id)).baseRetail)).toBe(199.99);
    const [row] = await prisma.productPriceChange.findMany();
    expect([row.source, row.actor, Number(row.fromRetail)]).toEqual([
      "MANUAL",
      "boss@example.com",
      250,
    ]);
    expect(
      (await prisma.auditEntry.findFirstOrThrow({ where: { event: "PRODUCT_PRICE_CHANGED" } }))
        .summary,
    ).toBe(`${p.name}: retail 250 → 199.99`);
  });

  it("locks and unlocks, with an entry each time it changes", async () => {
    const w = await world();
    const p = await product(w);
    await call(productRoute, "boss", "PATCH", { priceLocked: true }, { id: String(p.id) });
    expect((await fresh(p.id)).priceLocked).toBe(true);
    await call(productRoute, "boss", "PATCH", { priceLocked: true }, { id: String(p.id) });
    await call(productRoute, "boss", "PATCH", { priceLocked: false }, { id: String(p.id) });
    expect((await fresh(p.id)).priceLocked).toBe(false);
    expect(await prisma.auditEntry.count({ where: { event: "PRICE_LOCK_CHANGED" } })).toBe(2);
  });

  it("refuses a retail past the cent, and answers 404 for a product that isn't there", async () => {
    const w = await world();
    const p = await product(w);
    const res = await call(
      productRoute,
      "boss",
      "PATCH",
      { baseRetail: 9.999 },
      { id: String(p.id) },
    );
    expect(res.status).toBe(400);
    const gone = await call(productRoute, "boss", "PATCH", { name: "X" }, { id: "999999" });
    expect(gone.status).toBe(404);
  });

  it("shows the lock and the price history, newest first", async () => {
    const w = await world();
    const p = await product(w, { baseRetail: 250 });
    await call(productRoute, "boss", "PATCH", { baseRetail: 240 }, { id: String(p.id) });
    await call(productRoute, "boss", "PATCH", { baseRetail: 230 }, { id: String(p.id) });
    const res = await call(productRoute, "boss", "GET", {}, { id: String(p.id) });
    expect(res.body.priceLocked).toBe(false);
    expect(res.body.priceHistory.map((h: { toRetail: number }) => h.toRetail)).toEqual([230, 240]);
  });
});

describe("the mass price change", () => {
  it("lists products by vendor, category, text and lock, a page at a time", async () => {
    const w = await world();
    await product(w, { name: "Harbor Sofa" });
    await product(w, { name: "Harbor Loveseat", priceLocked: true });
    await product(w, { vendorId: w.other.id, categoryId: w.lamps.id, name: "Cedar Lamp" });
    const all = await call(listRoute, "boss", "GET", {}, { pageSize: "2" });
    expect([all.body.total, all.body.rows.length]).toEqual([3, 2]);
    const harbor = await call(
      listRoute,
      "boss",
      "GET",
      {},
      {
        vendorId: String(w.vendor.id),
        locked: "unlocked",
      },
    );
    expect(harbor.body.rows.map((r: { name: string }) => r.name)).toEqual(["Harbor Sofa"]);
    const lamps = await call(
      listRoute,
      "boss",
      "GET",
      {},
      { categoryId: String(w.lamps.id), q: "lamp" },
    );
    expect(lamps.body.total).toBe(1);
  });

  it("shows cost only to someone who may see it (View cost)", async () => {
    const w = await world();
    await product(w, { baseCost: 123 });
    await makeStaffHolding("pricer", ["catalog.read", "catalog.pricing"]);
    const boss = await call(listRoute, "boss", "GET");
    expect(boss.body.costVisible).toBe(true);
    expect(boss.body.rows[0].baseCost).toBe(123);
    const pricer = await call(listRoute, "pricer", "GET");
    expect(pricer.status).toBe(200);
    expect(pricer.body.costVisible).toBe(false);
    expect(pricer.body.rows[0]).not.toHaveProperty("baseCost");
    expect(pricer.body.rows[0].baseRetail).toBe(250);
  });

  it("gives its filters to pricing staff who can't edit the catalog, and to no one else", async () => {
    const w = await world();
    await makeStaffHolding("pricer", ["catalog.read", "catalog.pricing"]);
    const res = await call(optionsRoute, "pricer", "GET");
    expect(res.status).toBe(200);
    expect(res.body.vendors.map((v: { name: string }) => v.name)).toEqual([
      "Cedar Lane",
      "Harbor Works",
    ]);
    expect(res.body.departments).toEqual([{ id: w.department.id, name: "Living" }]);
    expect(res.body.categories).toEqual([
      { id: w.lamps.id, name: "Lamps", departmentId: w.department.id },
      { id: w.sofas.id, name: "Sofas", departmentId: w.department.id },
    ]);
    // Nothing else about a vendor (markup, terms, contacts) goes out.
    expect(Object.keys(res.body.vendors[0])).toEqual(["id", "name"]);
    expect((await call(optionsRoute, "clerk", "GET")).status).toBe(403);
  });

  it("previews from the markup that applies, rounded by the store's rule, saying why any is skipped", async () => {
    const w = await world();
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: {
        pricing: {
          defaultMarkup: 2.5,
          markupPrecedence: "CATEGORY_FIRST",
          retailRounding: "END_99",
        },
      },
    });
    invalidateAppSettingsCache();
    const sofa = await product(w, { baseCost: 100.1 }); // category 3 wins: 300.30 -> 299.99
    const lamp = await product(w, { categoryId: w.lamps.id, baseCost: 100 }); // vendor 2: 200 -> 199.99
    const otherLamp = await product(w, {
      vendorId: w.other.id,
      categoryId: w.lamps.id,
      baseCost: 100,
    }); // store 2.5: 250 -> 249.99
    const noCost = await product(w, { baseCost: null });
    const locked = await product(w, { priceLocked: true });
    const res = await call(previewRoute, "boss", "POST", {
      selection: { productIds: [sofa.id, lamp.id, otherLamp.id, noCost.id, locked.id] },
      operation: { retail: { kind: "FROM_MARKUP" }, was: "KEEP" },
    });
    expect(res.status).toBe(200);
    const byId = new Map(res.body.rows.map((r: { productId: number }) => [r.productId, r]));
    expect(byId.get(sofa.id)).toMatchObject({ fromRetail: 250, toRetail: 299.99, skipped: null });
    expect(byId.get(lamp.id)).toMatchObject({ toRetail: 199.99, skipped: null });
    expect(byId.get(otherLamp.id)).toMatchObject({ toRetail: 249.99, skipped: null });
    expect(byId.get(noCost.id)).toMatchObject({ skipped: "NO_COST" });
    expect(byId.get(locked.id)).toMatchObject({ skipped: "LOCKED" });
    expect(res.body.rounding).toBe("END_99");
    // A preview writes nothing.
    expect(await prisma.productPriceChange.count()).toBe(0);
  });

  it("applies a markdown in one batch: was price set, stale rows refused, locked kept, one entry", async () => {
    const w = await world();
    const a = await product(w, { baseRetail: 200 });
    const b = await product(w, { baseRetail: 300 });
    const moved = await product(w, { baseRetail: 400 });
    const preview = await call(previewRoute, "boss", "POST", {
      selection: { filter: { vendorId: w.vendor.id } },
      operation: {
        retail: { kind: "PERCENT", percent: -25 },
        was: "FROM_CURRENT",
        rounding: "CENTS",
      },
    });
    expect(preview.body.toChange).toBe(3);
    // Someone changes one price between the preview and the apply.
    await prisma.product.update({ where: { id: moved.id }, data: { baseRetail: 410 } });

    const rows = preview.body.rows.filter((r: { skipped: string | null }) => !r.skipped);
    const res = await call(applyRoute, "boss", "POST", { rows, note: "Spring markdown" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: 2, stale: [moved.id], skippedLocked: 0 });

    expect([Number((await fresh(a.id)).baseRetail), Number((await fresh(a.id)).wasPrice)]).toEqual([
      150, 200,
    ]);
    expect(Number((await fresh(b.id)).baseRetail)).toBe(225);
    expect(Number((await fresh(moved.id)).baseRetail)).toBe(410);
    const ledger = await prisma.productPriceChange.findMany();
    expect(ledger).toHaveLength(2);
    expect(new Set(ledger.map((r) => r.batchId))).toEqual(new Set([res.body.batchId]));
    expect(ledger.every((r) => r.source === "MASS_CHANGE" && r.note === "Spring markdown")).toBe(
      true,
    );
    const entries = await prisma.auditEntry.findMany({ where: { event: "PRICES_ADJUSTED" } });
    expect(entries).toHaveLength(1);
    expect(entries[0].details).toMatchObject({ batchId: res.body.batchId, changed: 2, stale: 1 });
  });

  it("keeps a product locked after its preview", async () => {
    const w = await world();
    const p = await product(w, { baseRetail: 200 });
    const preview = await call(previewRoute, "boss", "POST", {
      selection: { productIds: [p.id] },
      operation: { retail: { kind: "AMOUNT", amount: 180 }, was: "KEEP" },
    });
    await prisma.product.update({ where: { id: p.id }, data: { priceLocked: true } });
    const res = await call(applyRoute, "boss", "POST", { rows: preview.body.rows });
    expect(res.body).toMatchObject({ changed: 0, skippedLocked: 1 });
    expect(Number((await fresh(p.id)).baseRetail)).toBe(200);
    expect(await prisma.auditEntry.count({ where: { event: "PRICES_ADJUSTED" } })).toBe(0);
  });

  it("refuses a filter that matches more than the cap, rather than doing part of it", async () => {
    const w = await world();
    await prisma.product.createMany({
      data: Array.from({ length: MASS_CHANGE_MAX_PRODUCTS + 1 }, (_, i) => ({
        productNumber: `BULK-${i}`,
        name: `Bulk ${i}`,
        vendorId: w.vendor.id,
        departmentId: w.department.id,
        categoryId: w.sofas.id,
        baseRetail: 10,
      })),
    });
    const res = await call(previewRoute, "boss", "POST", {
      selection: { filter: { vendorId: w.vendor.id } },
      operation: { retail: { kind: "PERCENT", percent: 10 } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 2000/);
    const lock = await call(lockRoute, "boss", "POST", {
      selection: { filter: { vendorId: w.vendor.id } },
      locked: true,
    });
    expect(lock.status).toBe(400);
    expect(await prisma.product.count({ where: { priceLocked: true } })).toBe(0);
  });

  it("locks a selection with one entry for the run", async () => {
    const w = await world();
    const a = await product(w);
    const b = await product(w, { priceLocked: true });
    const res = await call(lockRoute, "boss", "POST", {
      selection: { productIds: [a.id, b.id] },
      locked: true,
    });
    expect(res.body).toMatchObject({ changed: 1, unchanged: 1 });
    expect((await fresh(a.id)).priceLocked).toBe(true);
    expect(await prisma.auditEntry.count({ where: { event: "PRICE_LOCK_CHANGED" } })).toBe(1);
  });

  it("is closed to anyone without Change pricing", async () => {
    const w = await world();
    const p = await product(w);
    const selection = { productIds: [p.id] };
    const row = { productId: p.id, fromRetail: 250, toRetail: 1, fromWas: null, toWas: null };
    for (const who of ["clerk", "till"]) {
      expect((await call(listRoute, who, "GET")).status).toBe(403);
      expect(
        (
          await call(previewRoute, who, "POST", {
            selection,
            operation: { retail: { kind: "AMOUNT", amount: 1 } },
          })
        ).status,
      ).toBe(403);
      expect((await call(applyRoute, who, "POST", { rows: [row] })).status).toBe(403);
      expect((await call(lockRoute, who, "POST", { selection, locked: true })).status).toBe(403);
    }
    expect(Number((await fresh(p.id)).baseRetail)).toBe(250);
  });
});

describe("what a mass change won't write, and what it lets through", () => {
  it("keeps a retail stored past the cent when the run only changes the was price", async () => {
    const w = await world();
    // Old imports wrote cost x markup unrounded; Product.baseRetail is unbounded.
    const p = await product(w, { baseRetail: 34.06326, wasPrice: 50 });
    const preview = await call(previewRoute, "boss", "POST", {
      selection: { productIds: [p.id] },
      operation: { retail: { kind: "KEEP" }, was: "CLEAR" },
    });
    expect(preview.body.rows[0]).toMatchObject({ toRetail: 34.06326, toWas: null, skipped: null });
    const res = await call(applyRoute, "boss", "POST", { rows: preview.body.rows });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: 1 });
    const after = await fresh(p.id);
    expect([Number(after.baseRetail), after.wasPrice]).toEqual([34.06326, null]);
  });

  it("still refuses a new retail past the cent, naming the product", async () => {
    const w = await world();
    const p = await product(w, { baseRetail: 250, name: "Harbor Sofa" });
    const res = await call(applyRoute, "boss", "POST", {
      rows: [{ productId: p.id, fromRetail: 250, toRetail: 9.999, fromWas: null, toWas: null }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Harbor Sofa.*to the cent/);
    expect(Number((await fresh(p.id)).baseRetail)).toBe(250);
  });

  it("skips a computed price that rounds to $0, which the register can't sell", async () => {
    const w = await world();
    const cheap = await product(w, { baseRetail: 1 });
    const costly = await product(w, { baseRetail: 10 });
    const percent = await call(previewRoute, "boss", "POST", {
      selection: { productIds: [cheap.id, costly.id] },
      operation: {
        retail: { kind: "PERCENT", percent: -60 },
        was: "KEEP",
        rounding: "WHOLE_NEAREST",
      },
    });
    const byId = new Map(percent.body.rows.map((r: { productId: number }) => [r.productId, r]));
    expect(byId.get(cheap.id)).toMatchObject({ skipped: "ROUNDS_TO_ZERO" }); // 0.40 -> 0
    expect(byId.get(costly.id)).toMatchObject({ toRetail: 4, skipped: null });
    const markup = await call(previewRoute, "boss", "POST", {
      selection: { productIds: [cheap.id] },
      operation: { retail: { kind: "FROM_MARKUP" }, rounding: "WHOLE_NEAREST" },
    });
    // Vendor markup 2 on cost 100 is 200; on cost 0.20 it would be 0.
    await prisma.product.update({ where: { id: cheap.id }, data: { baseCost: 0.2 } });
    const tiny = await call(previewRoute, "boss", "POST", {
      selection: { productIds: [cheap.id] },
      operation: { retail: { kind: "FROM_MARKUP" }, rounding: "WHOLE_NEAREST" },
    });
    expect(markup.body.rows[0]).toMatchObject({ toRetail: 200, skipped: null });
    expect(tiny.body.rows[0]).toMatchObject({ skipped: "ROUNDS_TO_ZERO" });
  });

  it("skips a was price that wouldn't be above the new retail, and apply refuses one", async () => {
    const w = await world();
    const rising = await product(w, { baseRetail: 100 });
    const oldWas = await product(w, { baseRetail: 100, wasPrice: 120 });
    const up = await call(previewRoute, "boss", "POST", {
      selection: { productIds: [rising.id] },
      operation: { retail: { kind: "PERCENT", percent: 10 }, was: "FROM_CURRENT" },
    });
    expect(up.body.rows[0]).toMatchObject({ toRetail: 110, toWas: 100, skipped: "WAS_NOT_ABOVE" });
    const keep = await call(previewRoute, "boss", "POST", {
      selection: { productIds: [rising.id] },
      operation: { retail: { kind: "KEEP" }, was: "FROM_CURRENT" },
    });
    expect(keep.body.rows[0]).toMatchObject({ skipped: "WAS_NOT_ABOVE" });
    const kept = await call(previewRoute, "boss", "POST", {
      selection: { productIds: [oldWas.id] },
      operation: { retail: { kind: "AMOUNT", amount: 130 }, was: "KEEP" },
    });
    expect(kept.body.rows[0]).toMatchObject({ toWas: 120, skipped: "WAS_NOT_ABOVE" });
    expect(kept.body.toChange).toBe(0);

    const res = await call(applyRoute, "boss", "POST", {
      rows: [{ productId: rising.id, fromRetail: 100, toRetail: 110, fromWas: null, toWas: 100 }],
    });
    expect(res.status).toBe(400);
    const after = await fresh(rising.id);
    expect([Number(after.baseRetail), after.wasPrice]).toEqual([100, null]);
  });
});

describe("cost × markup and View cost", () => {
  it("refuses cost × markup to pricing staff without View cost, and leaves them the rest", async () => {
    const w = await world();
    const p = await product(w, { baseCost: 123 });
    await makeStaffHolding("pricer", ["catalog.read", "catalog.pricing"]);
    const selection = { productIds: [p.id] };
    const markup = await call(previewRoute, "pricer", "POST", {
      selection,
      operation: { retail: { kind: "FROM_MARKUP" }, rounding: "CENTS" },
    });
    expect(markup.status).toBe(403);
    expect(markup.body).not.toHaveProperty("rows");
    const percent = await call(previewRoute, "pricer", "POST", {
      selection,
      operation: { retail: { kind: "PERCENT", percent: -10 } },
    });
    expect(percent.status).toBe(200);
    expect(percent.body.rows[0]).toMatchObject({ toRetail: 225 });
    const boss = await call(previewRoute, "boss", "POST", {
      selection,
      operation: { retail: { kind: "FROM_MARKUP" }, rounding: "CENTS" },
    });
    expect(boss.body.rows[0]).toMatchObject({ toRetail: 246 });
  });
});

describe("the demo seed's markdown", () => {
  it("is one batch with its PRICES_ADJUSTED entry, as a run from the screen is", async () => {
    const w = await world();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await product(w, { baseRetail: 100 + i * 10 }));
    const catalog = made.map((p) => ({
      id: p.id,
      baseRetail: Number(p.baseRetail),
    })) as unknown as CatalogProduct[];
    const result = await seedPriceChanges(prisma, catalog);
    expect(result).toEqual({ changed: 4, locked: 1 });
    const ledger = await prisma.productPriceChange.findMany();
    expect(new Set(ledger.map((r) => r.batchId))).toEqual(new Set(["seed-demo-markdown"]));
    const entries = await prisma.auditEntry.findMany({ where: { event: "PRICES_ADJUSTED" } });
    expect(entries).toHaveLength(1);
    expect(entries[0].details).toMatchObject({ batchId: "seed-demo-markdown", changed: 4 });
  });
});

describe("the store's pricing settings", () => {
  it("saves what is sent over what is stored, and names what changed", async () => {
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { pricing: { defaultMarkup: 2.2 } },
    });
    invalidateAppSettingsCache();
    const res = await call(settingsRoute, "boss", "PUT", { pricing: { retailRounding: "END_99" } });
    expect(res.status).toBe(200);
    expect(res.body.settings.pricing).toEqual({
      defaultMarkup: 2.2,
      markupPrecedence: "VENDOR_FIRST",
      retailRounding: "END_99",
      tradeDiscountOnSaleItems: false,
    });
    const entry = await prisma.auditEntry.findFirstOrThrow({ where: { event: "SETTINGS_SAVED" } });
    expect(entry.summary).toBe("Changed: pricing.retailRounding");

    await call(settingsRoute, "boss", "PUT", {
      pricing: { defaultMarkup: null, markupPrecedence: "CATEGORY_FIRST" },
    });
    invalidateAppSettingsCache();
    expect((await getAppSettings()).pricing).toEqual({
      defaultMarkup: null,
      markupPrecedence: "CATEGORY_FIRST",
      retailRounding: "END_99",
      tradeDiscountOnSaleItems: false,
    });
  });

  it("records nothing for a save that changes nothing", async () => {
    await call(settingsRoute, "boss", "PUT", { pricing: { retailRounding: "CENTS" } });
    await call(settingsRoute, "boss", "PUT", { pricing: { retailRounding: "CENTS" } });
    expect(await prisma.auditEntry.count({ where: { event: "SETTINGS_SAVED" } })).toBe(0);
  });

  it("refuses a markup that isn't one and a rule it doesn't know", async () => {
    for (const pricing of [
      { defaultMarkup: 0 },
      { defaultMarkup: "2.2" },
      { markupPrecedence: "STORE_FIRST" },
      { retailRounding: "NICKELS" },
    ]) {
      expect((await call(settingsRoute, "boss", "PUT", { pricing })).status).toBe(400);
    }
    expect((await getAppSettings()).pricing.retailRounding).toBe("CENTS");
  });
});

describe("a category's markup", () => {
  it("is kept by a PUT that doesn't send it", async () => {
    const w = await world();
    const res = await call(
      categoryRoute,
      "clerk",
      "PUT",
      { name: "Sofas & Sectionals", departmentId: String(w.department.id) },
      { id: String(w.sofas.id) },
    );
    expect(res.status).toBe(200);
    const after = await prisma.category.findUniqueOrThrow({ where: { id: w.sofas.id } });
    expect([after.name, Number(after.defaultMarkup)]).toEqual(["Sofas & Sectionals", 3]);
  });

  it("needs Change pricing to change, and records who changed it", async () => {
    const w = await world();
    const body = { name: "Sofas", departmentId: String(w.department.id), defaultMarkup: 2.75 };
    const query = { id: String(w.sofas.id) };
    expect((await call(categoryRoute, "clerk", "PUT", body, query)).status).toBe(403);
    expect(
      Number(
        (await prisma.category.findUniqueOrThrow({ where: { id: w.sofas.id } })).defaultMarkup,
      ),
    ).toBe(3);

    expect((await call(categoryRoute, "boss", "PUT", body, query)).status).toBe(200);
    expect(
      Number(
        (await prisma.category.findUniqueOrThrow({ where: { id: w.sofas.id } })).defaultMarkup,
      ),
    ).toBe(2.75);
    const entry = await prisma.auditEntry.findFirstOrThrow({ where: { event: "MARKUP_CHANGED" } });
    expect(entry.summary).toBe("Sofas: category markup 3 → 2.75");

    // Resending the same markup is no change, so catalog-only staff may save the form.
    expect((await call(categoryRoute, "clerk", "PUT", body, query)).status).toBe(200);
    // Clearing it follows the vendor's or the store's again.
    await call(categoryRoute, "boss", "PUT", { ...body, defaultMarkup: null }, query);
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id: w.sofas.id } })).defaultMarkup,
    ).toBeNull();
  });

  it("can be given when the category is created, by pricing staff only, and is recorded", async () => {
    const w = await world();
    const body = { name: "Rugs", departmentId: w.department.id, defaultMarkup: 2.4 };
    const refused = await call(categoriesRoute, "clerk", "POST", body);
    expect(refused.status).toBe(403);
    expect(await prisma.category.count({ where: { name: "Rugs" } })).toBe(0);
    // Without a markup, catalog-only staff create categories as before.
    const plain = await call(categoriesRoute, "clerk", "POST", { ...body, defaultMarkup: "" });
    expect(plain.status).toBe(201);
    expect(plain.body.defaultMarkup).toBeNull();
    const made = await call(categoriesRoute, "boss", "POST", { ...body, name: "Mirrors" });
    expect(made.status).toBe(201);
    expect(Number(made.body.defaultMarkup)).toBe(2.4);
    const entries = await prisma.auditEntry.findMany({ where: { event: "MARKUP_CHANGED" } });
    expect(entries.map((e) => e.summary)).toEqual(["Mirrors: category markup none → 2.4"]);
    expect(
      (await call(categoriesRoute, "boss", "POST", { ...body, name: "Bad", defaultMarkup: 0 }))
        .status,
    ).toBe(400);
  });

  it("refuses a markup of zero", async () => {
    const w = await world();
    const res = await call(
      categoryRoute,
      "boss",
      "PUT",
      { name: "Sofas", departmentId: String(w.department.id), defaultMarkup: 0 },
      { id: String(w.sofas.id) },
    );
    expect(res.status).toBe(400);
  });
});

describe("a vendor's markup", () => {
  it("is a multiplier above zero, and who changed it is recorded once per change", async () => {
    const w = await world();
    const query = { id: String(w.vendor.id) };
    expect((await call(vendorRoute, "boss", "PATCH", { defaultMarkup: 0 }, query)).status).toBe(
      400,
    );
    expect((await call(vendorRoute, "boss", "PATCH", { defaultMarkup: "abc" }, query)).status).toBe(
      400,
    );
    expect((await call(vendorRoute, "boss", "PATCH", { defaultMarkup: 2.4 }, query)).status).toBe(
      200,
    );
    await call(vendorRoute, "boss", "PATCH", { defaultMarkup: 2.4 }, query);
    const entries = await prisma.auditEntry.findMany({ where: { event: "MARKUP_CHANGED" } });
    expect(entries.map((e) => e.summary)).toEqual(["Harbor Works: vendor markup 2 → 2.4"]);
  });
});

describe("the configurator's markup", () => {
  it("gives each style its own markup: its category's where the store puts category first", async () => {
    const w = await world();
    await prisma.vendor.update({
      where: { id: w.vendor.id },
      data: { pricingModel: "GRADE_BASED" },
    });
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { pricing: { markupPrecedence: "CATEGORY_FIRST" } },
    });
    invalidateAppSettingsCache();
    await prisma.vendorStyle.create({
      data: { vendorId: w.vendor.id, styleNumber: "A-1", name: "Sofa", categoryId: w.sofas.id },
    });
    await prisma.vendorStyle.create({
      data: { vendorId: w.vendor.id, styleNumber: "B-1", name: "Loose" },
    });
    let status = 0;
    let body:
      | {
          vendor: { defaultMarkup: number };
          products: { productNumber: string; markup: number; markupSource: string }[];
        }
      | undefined;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: typeof body) {
        body = value;
        return this;
      },
    };
    await pricingProductsHandler(
      { method: "GET", query: { vendorId: String(w.vendor.id) } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse,
    );
    expect(status).toBe(200);
    expect(body!.vendor.defaultMarkup).toBe(2);
    expect(body!.products.map((p) => [p.productNumber, p.markup, p.markupSource])).toEqual([
      ["A-1", 3, "category"],
      ["B-1", 2, "vendor"],
    ]);
  });

  it("sends the vendor's own markup apart from the store's fallback, so its editor never saves the fallback onto it", async () => {
    const w = await world();
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { pricing: { defaultMarkup: 2.5 } },
    });
    invalidateAppSettingsCache();
    await prisma.vendorStyle.create({
      data: { vendorId: w.other.id, styleNumber: "C-1", name: "Chair" },
    });
    const read = async (vendorId: number) => {
      let body: { vendor: { defaultMarkup: number | null; ownMarkup: number | null } } | undefined;
      const res = {
        status() {
          return this;
        },
        json(value: typeof body) {
          body = value;
          return this;
        },
      };
      await pricingProductsHandler(
        { method: "GET", query: { vendorId: String(vendorId) } } as unknown as NextApiRequest,
        res as unknown as NextApiResponse,
      );
      return body!.vendor;
    };
    expect(await read(w.other.id)).toMatchObject({ defaultMarkup: 2.5, ownMarkup: null });
    expect(await read(w.vendor.id)).toMatchObject({ defaultMarkup: 2, ownMarkup: 2 });
  });
});
