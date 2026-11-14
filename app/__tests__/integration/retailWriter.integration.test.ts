// __tests__/integration/retailWriter.integration.test.ts
//
// GAP-06: one writer for a product's retail (lib/pricing/retailWriter.ts). Real
// database, real routes and runners; only the session readers are mocked.
//
// What it protects:
//   - the writer: a locked price kept by automatic writers, unchanged prices
//     left alone, a stale preview refused, one ledger row per change, the audit
//     standing or falling with the change, the ledger append-only;
//   - every importer that overwrites an existing product's retail: a locked
//     price is kept, a blank cell keeps the product's own price (never 0), a
//     real change lands with its ledger row, and the count of what was kept
//     is reported (rule 42 -- the guard on every path, not one);
//   - every importer decides from the row it locks in the transaction that
//     writes it, so a price locked (or changed) while it runs is kept, and the
//     ledger's "from" is the price it replaced;
//   - the imports gated on "Edit catalog" or "Write purchase orders" keep an
//     existing product's price when the importer lacks "Change pricing".

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));

import type { NextApiRequest, NextApiResponse } from "next";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { applyRetailChanges, RetailWriteError, setPriceLocks } from "@/lib/pricing/retailWriter";
import { runGenericImport } from "@/lib/genericImportRunner";
import { runProductsImport, runStockByItemImport } from "@/lib/adapters/legacyPos/runners";
import importBasicRoute from "@/pages/api/products/import-basic";
import consignmentItemsRoute from "@/pages/api/consignment/import/consignment-items";
import manifestRoute from "@/pages/api/consignment/import/manifest";
import styleRoute from "@/pages/api/pricing/styles/[id]/index";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(route: Route, who: string, method: string, body: object, query = {}) {
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

/** Until a session other than this one waits on a lock (the import, on the product's row). */
async function untilAnotherWaits(tx: Prisma.TransactionClient) {
  for (let i = 0; i < 200; i++) {
    // Activity is read once per transaction unless the snapshot is cleared.
    await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text AS cleared`;
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The import never waited on the product's row.");
}

/**
 * Run an import while another connection holds the product's row, and change
 * the product there once the import is waiting on it -- a manager locking a
 * price, or a mass change, while a long import runs. An importer that decided
 * from a read taken before it waited writes over the change.
 */
async function changedMidImport<T>(
  productId: number,
  change: Prisma.ProductUpdateInput,
  runImport: () => Promise<T>,
): Promise<T> {
  const holder = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL!, max: 1 }),
  });
  let run: Promise<T> | undefined;
  try {
    await holder.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
        run = runImport();
        run.catch(() => undefined); // surfaced by the return below
        await untilAnotherWaits(tx);
        await tx.product.update({ where: { id: productId }, data: change });
      },
      { maxWait: 10000, timeout: 30000 },
    );
  } catch (err) {
    // Say what the import was doing, so a failure here names its cause.
    const state = run
      ? await Promise.race([
          run.then(
            () => "had finished",
            (e: unknown) => `had failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve("was still running"), 200)),
        ])
      : "never started";
    throw new Error(`${err instanceof Error ? err.message : String(err)} (the import ${state})`);
  } finally {
    await holder.$disconnect();
  }
  return run!;
}

const LOCK_AT_777 = { priceLocked: true, baseRetail: 777 };

let seq = 0;
async function taxonomy(vendorName = "Harbor Works") {
  const vendor = await prisma.vendor.upsert({
    where: { name: vendorName },
    update: {},
    create: { name: vendorName },
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
  return { vendor, department, category };
}

async function makeProduct(opts: {
  productNumber?: string;
  baseRetail?: number | null;
  wasPrice?: number | null;
  priceLocked?: boolean;
  externalId?: number;
  vendorName?: string;
  vendorStyleId?: number;
}) {
  const { vendor, department, category } = await taxonomy(opts.vendorName);
  seq += 1;
  return prisma.product.create({
    data: {
      productNumber: opts.productNumber ?? `P-${seq}`,
      name: `Product ${seq}`,
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseCost: 100,
      baseRetail: opts.baseRetail === undefined ? 250 : opts.baseRetail,
      wasPrice: opts.wasPrice ?? null,
      priceLocked: opts.priceLocked ?? false,
      externalId: opts.externalId,
      vendorStyleId: opts.vendorStyleId,
    },
  });
}

const retailOf = async (id: number) =>
  Number((await prisma.product.findUniqueOrThrow({ where: { id } })).baseRetail);
const ledgerOf = (productId: number) =>
  prisma.productPriceChange.findMany({ where: { productId }, orderBy: { id: "asc" } });

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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("applyRetailChanges", () => {
  it("changes the price, writes one ledger row from what to what, and records who", async () => {
    const p = await makeProduct({ baseRetail: 250, wasPrice: null });
    const result = await prisma.$transaction((tx) =>
      applyRetailChanges(tx, [{ productId: p.id, toRetail: 199.99, toWas: 250 }], {
        source: "MANUAL",
        actor: "pat@example.com",
        honourLock: true,
        audit: "each",
      }),
    );
    expect(result.changed.map((c) => c.productId)).toEqual([p.id]);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(after.baseRetail)).toBe(199.99);
    expect(Number(after.wasPrice)).toBe(250);
    const [row] = await ledgerOf(p.id);
    expect({
      fromRetail: Number(row.fromRetail),
      toRetail: Number(row.toRetail),
      fromWas: row.fromWas,
      toWas: Number(row.toWas),
      source: row.source,
      actor: row.actor,
    }).toEqual({
      fromRetail: 250,
      toRetail: 199.99,
      fromWas: null,
      toWas: 250,
      source: "MANUAL",
      actor: "pat@example.com",
    });
    const audit = await prisma.auditEntry.findFirstOrThrow({
      where: { event: "PRODUCT_PRICE_CHANGED" },
    });
    expect(audit.summary).toBe(`${p.name}: retail 250 → 199.99, was none → 250`);
  });

  it("leaves an unchanged price alone: no write, no ledger row, no audit", async () => {
    const p = await makeProduct({ baseRetail: 250 });
    const result = await prisma.$transaction((tx) =>
      applyRetailChanges(tx, [{ productId: p.id, toRetail: 250 }], {
        source: "MASS_CHANGE",
        actor: "pat",
        honourLock: true,
        audit: "each",
      }),
    );
    expect(result.unchanged).toEqual([p.id]);
    expect(await prisma.productPriceChange.count()).toBe(0);
    expect(await prisma.auditEntry.count()).toBe(0);
  });

  it("keeps a locked price for an automatic writer, and changes it for a person", async () => {
    const p = await makeProduct({ baseRetail: 250, priceLocked: true });
    const opts = { source: "MASS_CHANGE" as const, actor: "pat", audit: "caller" as const };
    const kept = await prisma.$transaction((tx) =>
      applyRetailChanges(tx, [{ productId: p.id, toRetail: 300 }], { ...opts, honourLock: true }),
    );
    expect(kept.skippedLocked).toEqual([p.id]);
    expect(await retailOf(p.id)).toBe(250);
    expect(await prisma.productPriceChange.count()).toBe(0);

    const changed = await prisma.$transaction((tx) =>
      applyRetailChanges(tx, [{ productId: p.id, toRetail: 300 }], { ...opts, honourLock: false }),
    );
    expect(changed.changed).toHaveLength(1);
    expect(await retailOf(p.id)).toBe(300);
  });

  it("refuses a stale row -- its price moved after the preview -- and changes the rest", async () => {
    const moved = await makeProduct({ baseRetail: 260 });
    const fresh = await makeProduct({ baseRetail: 250 });
    const result = await prisma.$transaction((tx) =>
      applyRetailChanges(
        tx,
        [
          { productId: moved.id, toRetail: 200, expectFromRetail: 250 },
          { productId: fresh.id, toRetail: 200, expectFromRetail: 250 },
          { productId: 999999, toRetail: 200 },
        ],
        { source: "MASS_CHANGE", actor: "pat", honourLock: true, audit: "caller" },
      ),
    );
    expect(result.stale).toEqual([moved.id]);
    expect(result.missing).toEqual([999999]);
    expect(await retailOf(moved.id)).toBe(260);
    expect(await retailOf(fresh.id)).toBe(200);
  });

  it("refuses a price that isn't one, before writing anything", async () => {
    const p = await makeProduct({ baseRetail: 250 });
    const run = (change: object) =>
      prisma.$transaction((tx) =>
        applyRetailChanges(tx, [{ productId: p.id, ...change }], {
          source: "MANUAL",
          actor: "pat",
          honourLock: false,
          audit: "each",
        }),
      );
    await expect(run({ toRetail: 19.999 })).rejects.toThrow(RetailWriteError);
    await expect(run({ toRetail: -1 })).rejects.toThrow(RetailWriteError);
    await expect(run({ toWas: 0 })).rejects.toThrow(RetailWriteError);
    expect(await retailOf(p.id)).toBe(250);
  });

  it("stands or falls with the transaction: a later failure undoes the price, its ledger row and its audit", async () => {
    const p = await makeProduct({ baseRetail: 250 });
    await expect(
      prisma.$transaction(async (tx) => {
        await applyRetailChanges(tx, [{ productId: p.id, toRetail: 100 }], {
          source: "MANUAL",
          actor: "pat",
          honourLock: false,
          audit: "each",
        });
        throw new Error("the rest of the save failed");
      }),
    ).rejects.toThrow("the rest of the save failed");
    expect(await retailOf(p.id)).toBe(250);
    expect(await prisma.productPriceChange.count()).toBe(0);
    expect(await prisma.auditEntry.count()).toBe(0);
  });

  it("keeps the ledger append-only: a row cannot be edited or deleted", async () => {
    const p = await makeProduct({ baseRetail: 250 });
    await prisma.$transaction((tx) =>
      applyRetailChanges(tx, [{ productId: p.id, toRetail: 100 }], {
        source: "MANUAL",
        actor: "pat",
        honourLock: false,
        audit: "caller",
      }),
    );
    const [row] = await ledgerOf(p.id);
    await expect(
      prisma.productPriceChange.update({ where: { id: row.id }, data: { toRetail: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.productPriceChange.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("setPriceLocks", () => {
  it("locks what isn't locked, once, with an entry each", async () => {
    const a = await makeProduct({ priceLocked: false });
    const b = await makeProduct({ priceLocked: true });
    const result = await prisma.$transaction((tx) =>
      setPriceLocks(tx, [a.id, b.id], true, { actor: "pat", audit: "each" }),
    );
    expect(result.changed.map((c) => c.productId)).toEqual([a.id]);
    expect(result.unchanged).toEqual([b.id]);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).priceLocked).toBe(
      true,
    );
    expect(await prisma.auditEntry.count({ where: { event: "PRICE_LOCK_CHANGED" } })).toBe(1);
  });
});

describe("importers keep a locked price and a blank cell's price", () => {
  it("the basic product import", async () => {
    const { vendor, department, category } = await taxonomy();
    const type = await prisma.type.create({
      data: { name: "Stationary", categoryId: category.id },
    });
    const locked = await makeProduct({ productNumber: "B-1", baseRetail: 999, priceLocked: true });
    const blank = await makeProduct({ productNumber: "B-2", baseRetail: 450 });
    const moved = await makeProduct({ productNumber: "B-3", baseRetail: 300 });
    const record = (productNumber: string, retailPrice: string) => ({
      productNumber,
      name: `Imported ${productNumber}`,
      vendorName: vendor.name,
      departmentName: department.name,
      categoryName: category.name,
      typeName: type.name,
      cost: "100",
      retailPrice,
    });
    const res = await call(importBasicRoute, "boss", "POST", {
      records: [record("B-1", "500"), record("B-2", ""), record("B-3", "325.5")],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ priceLockedKept: 1, priceBlankKept: 1 });
    expect(await retailOf(locked.id)).toBe(999);
    expect(await retailOf(blank.id)).toBe(450);
    expect(await retailOf(moved.id)).toBe(325.5);
    const rows = await prisma.productPriceChange.findMany();
    expect(rows.map((r) => [r.productId, r.source, Number(r.toRetail)])).toEqual([
      [moved.id, "IMPORT", 325.5],
    ]);
  });

  it("the basic import's auto markup is a multiplier, from the markup that applies", async () => {
    const { vendor, department, category } = await taxonomy();
    await prisma.vendor.update({ where: { id: vendor.id }, data: { defaultMarkup: 2.2 } });
    const type = await prisma.type.create({
      data: { name: "Stationary", categoryId: category.id },
    });
    const res = await call(importBasicRoute, "boss", "POST", {
      records: [
        {
          productNumber: "AM-1",
          name: "Marked up",
          vendorName: vendor.name,
          departmentName: department.name,
          categoryName: category.name,
          typeName: type.name,
          cost: "100",
          retailPrice: "",
          autoMarkup: "TRUE",
        },
      ],
    });
    expect(res.status).toBe(200);
    const product = await prisma.product.findFirstOrThrow({ where: { productNumber: "AM-1" } });
    // Was cost x (1 + 2.2/100) = 102.20 when the markup was read as a percent.
    expect(Number(product.baseRetail)).toBe(220);
  });

  it("the data import's product runner", async () => {
    const locked = await makeProduct({ productNumber: "G-1", baseRetail: 999, priceLocked: true });
    const blank = await makeProduct({ productNumber: "G-2", baseRetail: 450 });
    const moved = await makeProduct({ productNumber: "G-3", baseRetail: 300 });
    const mapping = {
      productNumber: "SKU",
      name: "Name",
      vendor: "Vendor",
      department: "Dept",
      category: "Cat",
      baseCost: "Cost",
      baseRetail: "Retail",
    };
    const row = (sku: string, retail: string) => ({
      SKU: sku,
      Name: `Imported ${sku}`,
      Vendor: "Harbor Works",
      Dept: "Living",
      Cat: "Sofas",
      Cost: "100",
      Retail: retail,
    });
    const result = await runGenericImport(
      "product",
      mapping,
      [row("G-1", "500"), row("G-2", ""), row("G-3", "310")],
      "importer@example.com",
    );
    expect(result).toMatchObject({ imported: 3, priceLockedKept: 1, priceBlankKept: 1 });
    expect(result.notes?.[0]).toMatch(/price locked, kept: 1/);
    expect(await retailOf(locked.id)).toBe(999);
    expect(await retailOf(blank.id)).toBe(450);
    expect(await retailOf(moved.id)).toBe(310);
    const rows = await prisma.productPriceChange.findMany();
    expect(rows.map((r) => [r.productId, r.source, r.actor])).toEqual([
      [moved.id, "IMPORT", "importer@example.com"],
    ]);
  });

  it("the point-of-sale stock-by-item feed, once per product however many location rows", async () => {
    const locked = await makeProduct({ baseRetail: 999, priceLocked: true, externalId: 11 });
    const blank = await makeProduct({ baseRetail: 450, externalId: 12 });
    const moved = await makeProduct({ baseRetail: 300, externalId: 13 });
    const row = (stockId: number, sellingPrice: string, location: string) => ({
      Stockid: String(stockId),
      "Part No": `X-${stockId}`,
      "Product Name": `Product ${stockId}`,
      "On Hand": "1",
      "Cost Price": "100",
      SellingPrice: sellingPrice,
      Supplier: "Harbor Works",
      Department: "Living",
      Category: "Sofas",
      Stocklocation: location,
    });
    const result = await runStockByItemImport(
      [
        row(11, "500", ""),
        row(11, "500", ""),
        row(12, "", ""),
        row(13, "330", ""),
        row(13, "330", ""),
      ],
      "feed@example.com",
    );
    expect(result).toMatchObject({ priceLockedKept: 1, priceBlankKept: 1 });
    expect(result.message).toMatch(/price locked, kept: 1/);
    expect(await retailOf(locked.id)).toBe(999);
    // A blank SellingPrice used to be written as 0, which the register treats as no price.
    expect(await retailOf(blank.id)).toBe(450);
    expect(await retailOf(moved.id)).toBe(330);
    const rows = await prisma.productPriceChange.findMany();
    expect(rows.map((r) => [r.productId, r.source, Number(r.fromRetail)])).toEqual([
      [moved.id, "LEGACY_FEED", 300],
    ]);
  });

  it("the point-of-sale item export", async () => {
    const locked = await makeProduct({ baseRetail: 999, priceLocked: true, externalId: 21 });
    const blank = await makeProduct({ baseRetail: 450, externalId: 22 });
    const moved = await makeProduct({ baseRetail: 300, externalId: 23 });
    const row = (id: number, sellingPrice: string) => ({
      Id: String(id),
      "Part No": `IE-${id}`,
      "Product Name": `Product ${id}`,
      Supplier: "Harbor Works",
      Department: "Living",
      Category: "Sofas",
      "Selling Price": sellingPrice,
      "Purchasing Cost": "100",
      Active: "yes",
    });
    const result = await runProductsImport([row(21, "500"), row(22, ""), row(23, "340")]);
    expect(result).toMatchObject({ productsUpdated: 3, priceLockedKept: 1, priceBlankKept: 1 });
    expect(await retailOf(locked.id)).toBe(999);
    expect(await retailOf(blank.id)).toBe(450);
    expect(await retailOf(moved.id)).toBe(340);
    const rows = await prisma.productPriceChange.findMany();
    expect(rows.map((r) => [r.productId, r.source])).toEqual([[moved.id, "LEGACY_FEED"]]);
  });

  async function consignor() {
    return prisma.vendor.create({ data: { name: "Loom Consignor", isConsignment: true } });
  }

  it("the consignment items import", async () => {
    const vendor = await consignor();
    const locked = await makeProduct({
      productNumber: "RUG-1",
      baseRetail: 999,
      priceLocked: true,
      vendorName: vendor.name,
    });
    const blank = await makeProduct({
      productNumber: "RUG-2",
      baseRetail: 450,
      vendorName: vendor.name,
    });
    const moved = await makeProduct({
      productNumber: "RUG-3",
      baseRetail: 300,
      vendorName: vendor.name,
    });
    const res = await call(consignmentItemsRoute, "boss", "POST", {
      rows: [
        { barcode: "RUG-1", cost: "100" },
        { barcode: "RUG-2", cost: "" },
        { barcode: "RUG-3", cost: "100" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 3, priceLockedKept: 1, priceBlankKept: 1 });
    expect(await retailOf(locked.id)).toBe(999);
    expect(await retailOf(blank.id)).toBe(450);
    // The import prices a rug from its cost (lib/consignment.ts calculateRugPricing).
    expect(await retailOf(moved.id)).toBe(350);
    const rows = await prisma.productPriceChange.findMany();
    expect(rows.map((r) => [r.productId, r.source])).toEqual([[moved.id, "CONSIGNMENT_IMPORT"]]);
  });

  it("the consignment manifest import", async () => {
    const vendor = await consignor();
    const locked = await makeProduct({
      productNumber: "MF-1",
      baseRetail: 999,
      priceLocked: true,
      vendorName: vendor.name,
    });
    const blank = await makeProduct({
      productNumber: "MF-2",
      baseRetail: 450,
      vendorName: vendor.name,
    });
    const moved = await makeProduct({
      productNumber: "MF-3",
      baseRetail: 300,
      vendorName: vendor.name,
    });
    const res = await call(manifestRoute, "boss", "POST", {
      rows: [
        { rugNumber: "MF-1", cost: 100 },
        { rugNumber: "MF-2", cost: "" },
        { rugNumber: "MF-3", cost: 100 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 3, priceLockedKept: 1, priceBlankKept: 1 });
    expect(await retailOf(locked.id)).toBe(999);
    expect(await retailOf(blank.id)).toBe(450);
    expect(await retailOf(moved.id)).toBe(350);
    const rows = await prisma.productPriceChange.findMany();
    expect(rows.map((r) => [r.productId, r.source])).toEqual([[moved.id, "CONSIGNMENT_IMPORT"]]);
  });

  it("a vendor style's retail reaches its products through the writer, and a locked one keeps its own", async () => {
    const { vendor } = await taxonomy();
    const style = await prisma.vendorStyle.create({
      data: { vendorId: vendor.id, styleNumber: "ST-1", name: "Harbor", baseRetail: 300 },
    });
    const locked = await makeProduct({
      baseRetail: 999,
      priceLocked: true,
      vendorStyleId: style.id,
    });
    const linked = await makeProduct({ baseRetail: 300, vendorStyleId: style.id });
    const res = await call(
      styleRoute,
      "boss",
      "PUT",
      { fields: { baseRetail: "349.5" } },
      { id: String(style.id) },
    );
    expect(res.status).toBe(200);
    expect(await retailOf(locked.id)).toBe(999);
    expect(await retailOf(linked.id)).toBe(349.5);
    const rows = await prisma.productPriceChange.findMany();
    expect(rows.map((r) => [r.productId, r.source, r.actor])).toEqual([
      [linked.id, "STYLE_EDIT", "boss@example.com"],
    ]);
  });
});

describe("importers decide from the row they lock, so a lock made mid-import holds", () => {
  async function expectKeptAt777(productId: number) {
    const after = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect([Number(after.baseRetail), after.priceLocked]).toEqual([777, true]);
    expect(await ledgerOf(productId)).toEqual([]);
  }

  it("the basic product import", async () => {
    const { vendor, department, category } = await taxonomy();
    const type = await prisma.type.create({
      data: { name: "Stationary", categoryId: category.id },
    });
    const p = await makeProduct({ productNumber: "RB-1", baseRetail: 300 });
    const res = await changedMidImport(p.id, LOCK_AT_777, () =>
      call(importBasicRoute, "boss", "POST", {
        records: [
          {
            productNumber: "RB-1",
            name: "Imported",
            vendorName: vendor.name,
            departmentName: department.name,
            categoryName: category.name,
            typeName: type.name,
            cost: "100",
            retailPrice: "325",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ priceLockedKept: 1 });
    await expectKeptAt777(p.id);
  });

  it("the data import's product runner", async () => {
    const p = await makeProduct({ productNumber: "RG-1", baseRetail: 300 });
    const result = await changedMidImport(p.id, LOCK_AT_777, () =>
      runGenericImport(
        "product",
        { productNumber: "SKU", name: "Name", vendor: "Vendor", baseRetail: "Retail" },
        [{ SKU: "RG-1", Name: "Imported", Vendor: "Harbor Works", Retail: "310" }],
        "importer@example.com",
      ),
    );
    expect(result).toMatchObject({ imported: 1, priceLockedKept: 1 });
    await expectKeptAt777(p.id);
  });

  const stockRow = (stockId: number, sellingPrice: string) => ({
    Stockid: String(stockId),
    "Part No": `X-${stockId}`,
    "Product Name": `Product ${stockId}`,
    "On Hand": "1",
    "Cost Price": "100",
    SellingPrice: sellingPrice,
    Supplier: "Harbor Works",
    Department: "Living",
    Category: "Sofas",
    Stocklocation: "",
  });

  it("the point-of-sale stock-by-item feed", async () => {
    const p = await makeProduct({ baseRetail: 300, externalId: 31 });
    const result = await changedMidImport(p.id, LOCK_AT_777, () =>
      runStockByItemImport([stockRow(31, "330")], "feed@example.com"),
    );
    expect(result).toMatchObject({ priceLockedKept: 1 });
    await expectKeptAt777(p.id);
  });

  it("the stock-by-item feed's ledger row starts from the price it replaced, not the run's first read", async () => {
    const p = await makeProduct({ baseRetail: 300, externalId: 32 });
    await changedMidImport(p.id, { baseRetail: 777 }, () =>
      runStockByItemImport([stockRow(32, "330")], "feed@example.com"),
    );
    expect(await retailOf(p.id)).toBe(330);
    const [row] = await ledgerOf(p.id);
    expect([Number(row.fromRetail), Number(row.toRetail)]).toEqual([777, 330]);
  });

  it("the point-of-sale item export", async () => {
    const p = await makeProduct({ baseRetail: 300, externalId: 41 });
    const result = await changedMidImport(p.id, LOCK_AT_777, () =>
      runProductsImport([
        {
          Id: "41",
          "Part No": "IE-41",
          "Product Name": "Product 41",
          Supplier: "Harbor Works",
          Department: "Living",
          Category: "Sofas",
          "Selling Price": "340",
          "Purchasing Cost": "100",
          Active: "yes",
        },
      ]),
    );
    expect(result).toMatchObject({ productsUpdated: 1, priceLockedKept: 1 });
    await expectKeptAt777(p.id);
  });

  it("the consignment items import", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Loom Consignor", isConsignment: true },
    });
    const p = await makeProduct({
      productNumber: "RR-1",
      baseRetail: 300,
      vendorName: vendor.name,
    });
    const res = await changedMidImport(p.id, LOCK_AT_777, () =>
      call(consignmentItemsRoute, "boss", "POST", { rows: [{ barcode: "RR-1", cost: "100" }] }),
    );
    expect(res.body).toMatchObject({ imported: 1, priceLockedKept: 1 });
    await expectKeptAt777(p.id);
  });

  it("the consignment manifest import", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Loom Consignor", isConsignment: true },
    });
    const p = await makeProduct({
      productNumber: "RM-1",
      baseRetail: 300,
      vendorName: vendor.name,
    });
    const res = await changedMidImport(p.id, LOCK_AT_777, () =>
      call(manifestRoute, "boss", "POST", { rows: [{ rugNumber: "RM-1", cost: 100 }] }),
    );
    expect(res.body).toMatchObject({ imported: 1, priceLockedKept: 1 });
    await expectKeptAt777(p.id);
  });
});

describe("imports gated on Edit catalog or Write purchase orders need Change pricing to change a price", () => {
  it("the basic import keeps an existing product's price, and still creates a new one at the file's", async () => {
    await makeStaffHolding("clerk", ["catalog.read", "catalog.write"]);
    const { vendor, department, category } = await taxonomy();
    const type = await prisma.type.create({
      data: { name: "Stationary", categoryId: category.id },
    });
    const existing = await makeProduct({ productNumber: "PB-1", baseRetail: 300 });
    const record = (productNumber: string) => ({
      productNumber,
      name: `Imported ${productNumber}`,
      vendorName: vendor.name,
      departmentName: department.name,
      categoryName: category.name,
      typeName: type.name,
      cost: "100",
      retailPrice: "325",
    });
    const res = await call(importBasicRoute, "clerk", "POST", {
      records: [record("PB-1"), record("PB-2")],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ priceNoPermissionKept: 1 });
    expect(await retailOf(existing.id)).toBe(300);
    // The rest of the row still lands.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: existing.id } })).name).toBe(
      "Imported PB-1",
    );
    const created = await prisma.product.findFirstOrThrow({ where: { productNumber: "PB-2" } });
    expect(Number(created.baseRetail)).toBe(325);
    expect(await prisma.productPriceChange.count()).toBe(0);
  });

  it("both consignment imports keep an existing rug's price", async () => {
    await makeStaffHolding("buyer", ["catalog.read", "purchasing.read", "purchasing.write"]);
    const vendor = await prisma.vendor.create({
      data: { name: "Loom Consignor", isConsignment: true },
    });
    const item = await makeProduct({
      productNumber: "PC-1",
      baseRetail: 300,
      vendorName: vendor.name,
    });
    const rug = await makeProduct({
      productNumber: "PM-1",
      baseRetail: 300,
      vendorName: vendor.name,
    });
    const items = await call(consignmentItemsRoute, "buyer", "POST", {
      rows: [{ barcode: "PC-1", cost: "100" }],
    });
    expect(items.body).toMatchObject({ imported: 1, priceNoPermissionKept: 1 });
    const manifest = await call(manifestRoute, "buyer", "POST", {
      rows: [{ rugNumber: "PM-1", cost: 100 }],
    });
    expect(manifest.body).toMatchObject({ imported: 1, priceNoPermissionKept: 1 });
    expect([await retailOf(item.id), await retailOf(rug.id)]).toEqual([300, 300]);
    expect(await prisma.productPriceChange.count()).toBe(0);
  });
});

describe("a computed price that rounds to nothing is no price", () => {
  it("the basic import's auto markup leaves a new product unpriced rather than at $0", async () => {
    await prisma.appSettings.update({
      where: { organizationId: DEFAULT_ORG_ID },
      data: { pricing: { retailRounding: "WHOLE_NEAREST" } },
    });
    invalidateAppSettingsCache();
    const { vendor, department, category } = await taxonomy();
    await prisma.vendor.update({ where: { id: vendor.id }, data: { defaultMarkup: 2 } });
    const type = await prisma.type.create({
      data: { name: "Stationary", categoryId: category.id },
    });
    const res = await call(importBasicRoute, "boss", "POST", {
      records: [
        {
          productNumber: "Z-1",
          name: "Coaster",
          vendorName: vendor.name,
          departmentName: department.name,
          categoryName: category.name,
          typeName: type.name,
          cost: "0.20", // x 2 = 0.40, to the nearest dollar 0
          retailPrice: "",
          autoMarkup: "TRUE",
        },
      ],
    });
    expect(res.status).toBe(200);
    const product = await prisma.product.findFirstOrThrow({ where: { productNumber: "Z-1" } });
    expect(product.baseRetail).toBeNull();
  });
});
