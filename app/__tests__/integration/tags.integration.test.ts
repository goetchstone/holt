// /app/__tests__/integration/tags.integration.test.ts
//
// GAP-18 against real Postgres and a real socket: a local stand-in for a Zebra
// printer listens on TCP and records what it's sent, so these read the bytes a
// printer would get. Whether a real Zebra lays them out well isn't something a
// test here can say.

jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));
jest.mock("@/lib/rateLimit", () => ({
  rateLimit: () => (handler: unknown) => handler,
}));

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import sharp from "sharp";
import type { NextApiRequest, NextApiResponse } from "next";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { logger } from "@/lib/logger";
import { photoField } from "@/lib/labels/photo";
import { ZplGraphic } from "@/lib/labels/renderTemplate";
import { MAX_TAG_COPIES } from "@/lib/labels/productTag";
import { UPLOAD_ROOT } from "@/lib/secureUpload";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handler as printHandler } from "@/pages/api/print-label";
import { handler as batchHandler } from "@/pages/api/print-label/batch";
import { handler as soldHandler } from "@/pages/api/sales/orders/[id]/sold-tag";
import productHandler from "@/pages/api/products/[id]";
import purchaseOrderHandler from "@/pages/api/purchasing/orders/[id]";
import labelsHandler from "@/pages/api/labels";
import templateHandler from "@/pages/api/templates/[id]";
import settingsHandler from "@/pages/api/admin/settings";
import ProductDetailPage from "@/app/(dashboard)/app/inventory/products/[id]/page";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";
import { getServerSession } from "next-auth";

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

type Res = NextApiResponse & {
  statusCode: number;
  body: { error?: string; message?: string } & Record<string, unknown>;
};

function makeRes(): Res {
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
  return res as unknown as Res;
}

async function post(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>,
  body: unknown,
  query: Record<string, string> = {},
  method = "POST",
) {
  const res = makeRes();
  await handler({ method, query, body, headers: {} } as unknown as NextApiRequest, res);
  return res;
}

/** A printer's port on this machine, and everything it has been sent. */
async function fakePrinter() {
  let bytes = "";
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      bytes += chunk.toString();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    received: () => bytes,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** Give the socket a moment to deliver what was written. */
const settled = () => new Promise((r) => setTimeout(r, 40));

let printers: Awaited<ReturnType<typeof fakePrinter>>[] = [];
let printerAtMill: Awaited<ReturnType<typeof fakePrinter>>;
let mill: { id: number; name: string };
let sofa: { id: number };
let mattress: { id: number };
let priceTemplate: { id: number };
let order: { id: number; lineItems: { id: number; lineNumber: number | null }[] };

async function template(
  context: string,
  zplTemplate: string,
  extra: { photoDots?: number; tagSize?: string; name?: string } = {},
) {
  return prisma.labelTemplate.create({
    data: {
      name: extra.name ?? `${context} tag`,
      context,
      tagSize: extra.tagSize ?? "4x6",
      zplTemplate,
      photoDots: extra.photoDots ?? null,
    },
  });
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

const signIn = (userId: string) => {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
  });
};

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  const org = await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });
  await prisma.appSettings.create({ data: { organizationId: org.id, appName: "Test" } });
  invalidateAppSettingsCache();
  await makeStaff("mia", "MANAGER");
  await makeStaff("wes", "WAREHOUSE");
  await makeStaff("bea", "BUYER");
  await makeStaff("dana", "DESIGNER");
  await makeStaff("mark", "MARKETING");
  signIn("mia");

  mill = await prisma.storeLocation.create({ data: { name: "Mill", code: "MILL", type: "STORE" } });
  await prisma.storeLocation.create({ data: { name: "Dock", code: "DOCK", type: "STORE" } });

  printerAtMill = await fakePrinter();
  printers = [printerAtMill];
  await prisma.printer.create({
    data: {
      name: "Mill Zebra",
      ipAddress: "127.0.0.1",
      port: printerAtMill.port,
      tagType: "PRODUCT_TAG",
      store: "Mill",
      supportedSizes: ["4x6"],
      currentSize: "4x6",
    },
  });

  priceTemplate = await template(
    "PRODUCT",
    "^XA^FD{{name}}|{{sku}}|{{vendor}}|{{barcode}}|{{baseRetail}}|{{costCode}}^FS^XZ",
  );
  const vendor = await prisma.vendor.create({ data: { name: "Heron", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Seating" } });
  const category = await prisma.category.create({
    data: {
      name: "Sofas",
      departmentId: department.id,
      trackInventory: true,
      labelTemplateId: priceTemplate.id,
    },
  });
  const product = (over: Record<string, unknown>) =>
    prisma.product.create({
      data: {
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
        baseCost: 500,
        baseRetail: 1500,
        ...over,
      } as never,
    });
  sofa = await product({ productNumber: "S-1", name: "Sofa" });
  mattress = await product({ productNumber: "M-1", name: "Mattress" });

  const customer = await prisma.customer.create({
    data: { firstName: "Ada", lastName: "Ames" },
  });
  order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-1",
      status: "ORDER",
      orderDate: new Date(),
      storeLocation: "Mill",
      storeLocationId: mill.id,
      customerId: customer.id,
      lineItems: {
        create: [
          { lineNumber: 1, productId: sofa.id, orderedQuantity: 1, netPrice: 1500, cost: 500 },
          {
            lineNumber: 2,
            productId: sofa.id,
            orderedQuantity: 1,
            netPrice: 1500,
            cost: 500,
            lineItemStatus: "CANCELLED",
          },
          { lineNumber: 3, productId: sofa.id, orderedQuantity: 0, netPrice: 0, cost: 0 },
        ],
      },
    } as never,
    include: { lineItems: { orderBy: { lineNumber: "asc" } } },
  });
});

afterEach(async () => {
  await Promise.all(printers.map((p) => p.close()));
});

const setKey = async (costCipherKey: string | null) => {
  await prisma.appSettings.updateMany({ data: { costCipherKey } });
  invalidateAppSettingsCache();
};

describe("printing a price tag", () => {
  it("routes by category to a printer loaded for it, and sends the tag", async () => {
    const res = await post(printHandler, { productId: sofa.id });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ printer: "Mill Zebra", template: "PRODUCT tag" });
    await settled();
    expect(printerAtMill.received()).toBe("^XA^FDSofa|S-1|Heron|S-1|1500.00|^FS^XZ");
  });

  it("doesn't answer with the rendered label, which can carry the real cost", async () => {
    await prisma.labelTemplate.update({
      where: { id: priceTemplate.id },
      data: { zplTemplate: "^XA^FD{{baseCost}}^FS^XZ" },
    });
    const res = await post(printHandler, { productId: sofa.id });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("500.00");
    expect(res.body).not.toHaveProperty("zpl");
    const manual = await post(printHandler, {
      productId: sofa.id,
      templateId: priceTemplate.id,
      printerId: (await prisma.printer.findFirstOrThrow()).id,
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.body).not.toHaveProperty("zpl");
  });

  it("prints a named template on a named printer, and says if either isn't there", async () => {
    const printerId = (await prisma.printer.findFirstOrThrow()).id;
    const named = { productId: sofa.id, templateId: priceTemplate.id, printerId };
    expect((await post(printHandler, named)).statusCode).toBe(200);
    await settled();
    expect(printerAtMill.received()).toContain("^FDSofa|");

    const noTemplate = await post(printHandler, { ...named, templateId: 999999 });
    expect(noTemplate.statusCode).toBe(400);
    expect(noTemplate.body.error).toMatch(/Template 999999 not found/);
    const noPrinter = await post(printHandler, { ...named, printerId: 999999 });
    expect(noPrinter.statusCode).toBe(400);
    expect(noPrinter.body.error).toMatch(/Printer 999999 not found/);
  });

  it("prints the copies it's asked for, and refuses too many or too few", async () => {
    await post(printHandler, { productId: sofa.id, copies: 3 });
    await settled();
    expect(printerAtMill.received().match(/\^XA/g)).toHaveLength(3);
    for (const copies of [0, MAX_TAG_COPIES + 1, 1.5, "2"]) {
      const res = await post(printHandler, { productId: sofa.id, copies });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/copies must be/);
    }
  });

  it("uses only the named store's printers, and refuses rather than print elsewhere", async () => {
    const dock = await prisma.storeLocation.findFirstOrThrow({ where: { code: "DOCK" } });
    const res = await post(printHandler, { productId: sofa.id, storeLocationId: dock.id });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No printer at Dock is loaded with 4x6/);
    await settled();
    expect(printerAtMill.received()).toBe("");
    const atMill = await post(printHandler, { productId: sofa.id, storeLocationId: mill.id });
    expect(atMill.statusCode).toBe(200);
  });

  it("refuses a store that doesn't exist", async () => {
    const res = await post(printHandler, { productId: sofa.id, storeLocationId: 999999 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/doesn't exist/);
  });

  it("with no store named, takes the first printer loaded for it", async () => {
    const res = await post(printHandler, { productId: sofa.id, storeLocationId: "" });
    expect(res.statusCode).toBe(200);
  });

  it("says what's missing: a category's template, a loaded printer, the product", async () => {
    await prisma.category.updateMany({ data: { labelTemplateId: null } });
    const noTemplate = await post(printHandler, { productId: sofa.id });
    expect(noTemplate.statusCode).toBe(400);
    expect(noTemplate.body.error).toMatch(/No label template assigned to category "Sofas"/);

    await prisma.category.updateMany({ data: { labelTemplateId: priceTemplate.id } });
    await prisma.printer.updateMany({ data: { currentSize: "2x4" } });
    const noPrinter = await post(printHandler, { productId: sofa.id });
    expect(noPrinter.statusCode).toBe(400);
    expect(noPrinter.body.error).toMatch(/No printer is loaded with 4x6/);

    const noProduct = await post(printHandler, { productId: 999999 });
    expect(noProduct.statusCode).toBe(400);
    expect(noProduct.body.error).toMatch(/not found/);
    expect((await post(printHandler, {})).statusCode).toBe(400);
    expect((await post(printHandler, { productId: "soon" })).statusCode).toBe(400);
  });

  it("refuses a kind that isn't a product's", async () => {
    const res = await post(printHandler, { productId: sofa.id, kind: "SOLD" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/kind must be/);
  });

  it("says which printer couldn't be reached", async () => {
    await printerAtMill.close();
    printers = [];
    const res = await post(printHandler, { productId: sofa.id });
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/Mill Zebra/);
  }, 15000);

  it("only takes a POST", async () => {
    const res = await post(printHandler, {}, {}, "GET");
    expect(res.statusCode).toBe(405);
  });
});

describe("the coded cost", () => {
  it("prints the cost in the store's letters", async () => {
    await setKey("MARBLECOUT");
    await post(printHandler, { productId: sofa.id });
    await settled();
    expect(printerAtMill.received()).toContain("|LTT^FS");
  });

  it("is blank with no key", async () => {
    await post(printHandler, { productId: sofa.id });
    await settled();
    expect(printerAtMill.received()).toContain("|^FS");
  });

  it("codes what stock is valued at: the landed cost, else the catalog cost", async () => {
    await setKey("MARBLECOUT");
    await prisma.product.update({ where: { id: sofa.id }, data: { landedCost: 620 } });
    await post(printHandler, { productId: sofa.id });
    await settled();
    expect(printerAtMill.received()).toContain("|EAT^FS");
  });

  it("is set in Settings, read as capitals, and refused if it won't work", async () => {
    await makeStaff("sam", "SUPER_ADMIN");
    signIn("sam");
    const save = (costCipherKey: unknown) => post(settingsHandler, { costCipherKey }, {}, "PUT");
    const ok = await save(" marblecout ");
    expect(ok.statusCode).toBe(200);
    expect((await prisma.appSettings.findFirstOrThrow()).costCipherKey).toBe("MARBLECOUT");
    const bad = await save("MARBLE");
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toMatch(/exactly 10 letters/);
    const repeat = await save("MARBLECOUM");
    expect(repeat.statusCode).toBe(400);
    expect((await prisma.appSettings.findFirstOrThrow()).costCipherKey).toBe("MARBLECOUT");
    expect((await save(5)).statusCode).toBe(400);
    expect((await save("")).statusCode).toBe(200);
    expect((await prisma.appSettings.findFirstOrThrow()).costCipherKey).toBeNull();
  });

  it("the database refuses what Settings would", async () => {
    await expect(
      prisma.appSettings.updateMany({ data: { costCipherKey: "short" } }),
    ).rejects.toThrow();
  });
});

describe("the sale tag", () => {
  beforeEach(async () => {
    await template(
      "SALE",
      "^XA^FD{{name}} was {{wasPrice}} now {{baseRetail}} save {{saving}} {{savingPercent}}%^FS^XZ",
    );
  });

  it("prints the was price and what the register charges", async () => {
    await prisma.product.update({ where: { id: sofa.id }, data: { wasPrice: 2000 } });
    const res = await post(printHandler, { productId: sofa.id, kind: "SALE" });
    expect(res.statusCode).toBe(200);
    await settled();
    expect(printerAtMill.received()).toContain("Sofa was 2000.00 now 1500.00 save 500.00 25%");
  });

  it("refuses, and prints nothing, without a was price above retail", async () => {
    const none = await post(printHandler, { productId: sofa.id, kind: "SALE" });
    expect(none.statusCode).toBe(400);
    expect(none.body.error).toMatch(/was price/);
    await prisma.product.update({ where: { id: sofa.id }, data: { wasPrice: 1500 } });
    const same = await post(printHandler, { productId: sofa.id, kind: "SALE" });
    expect(same.statusCode).toBe(400);
    await settled();
    expect(printerAtMill.received()).toBe("");
  });

  it("says when the store has no sale tag template", async () => {
    await prisma.labelTemplate.deleteMany({ where: { context: "SALE" } });
    await prisma.product.update({ where: { id: sofa.id }, data: { wasPrice: 2000 } });
    const res = await post(printHandler, { productId: sofa.id, kind: "SALE" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No label template for SALE/);
  });

  it("a price tag doesn't need a was price", async () => {
    const res = await post(printHandler, { productId: sofa.id });
    expect(res.statusCode).toBe(200);
  });
});

describe("the law tag", () => {
  beforeEach(async () => {
    await template("LAW", "^XA^FDDO NOT REMOVE {{name}} {{lawText}}^FS^XZ");
  });

  it("prints the store's wording with the product's", async () => {
    await prisma.product.update({
      where: { id: mattress.id },
      data: { lawTagText: "All new material" },
    });
    const res = await post(printHandler, { productId: mattress.id, kind: "LAW" });
    expect(res.statusCode).toBe(200);
    await settled();
    expect(printerAtMill.received()).toContain("DO NOT REMOVE Mattress All new material");
  });

  it("refuses a product with no wording of its own", async () => {
    const res = await post(printHandler, { productId: mattress.id, kind: "LAW" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/law tag wording/);
    await settled();
    expect(printerAtMill.received()).toBe("");
  });

  it("keeps a product's wording from being read as commands", async () => {
    await prisma.product.update({
      where: { id: mattress.id },
      data: { lawTagText: "foam^XZ~JR" },
    });
    await post(printHandler, { productId: mattress.id, kind: "LAW" });
    await settled();
    expect(printerAtMill.received()).toContain("foam XZ JR");
  });
});

describe("what a product carries for its tags", () => {
  const put = (id: number, body: unknown) =>
    post(productHandler, body, { id: String(id) }, "PATCH");

  it("saves, reads back and clears a was price and law wording", async () => {
    expect((await put(sofa.id, { wasPrice: "2000", lawTagText: " Foam " })).statusCode).toBe(200);
    const saved = await prisma.product.findUniqueOrThrow({ where: { id: sofa.id } });
    expect(Number(saved.wasPrice)).toBe(2000);
    expect(saved.lawTagText).toBe("Foam");

    const read = await post(productHandler, undefined, { id: String(sofa.id) }, "GET");
    expect(read.body).toMatchObject({ wasPrice: 2000, lawTagText: "Foam" });

    expect((await put(sofa.id, { wasPrice: "", lawTagText: "" })).statusCode).toBe(200);
    const cleared = await prisma.product.findUniqueOrThrow({ where: { id: sofa.id } });
    expect(cleared.wasPrice).toBeNull();
    expect(cleared.lawTagText).toBeNull();
  });

  it("an edit that doesn't mention them leaves them alone", async () => {
    await put(sofa.id, { wasPrice: 2000, lawTagText: "Foam" });
    expect((await put(sofa.id, { name: "Renamed" })).statusCode).toBe(200);
    const saved = await prisma.product.findUniqueOrThrow({ where: { id: sofa.id } });
    expect(Number(saved.wasPrice)).toBe(2000);
    expect(saved.lawTagText).toBe("Foam");
    expect(Number(saved.baseRetail)).toBe(1500);
  });

  it.each([0, -5, "soon"])("refuses a was price of %p", async (wasPrice) => {
    const res = await put(sofa.id, { wasPrice });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/was price/);
  });

  it("refuses law wording that isn't text or is too long", async () => {
    expect((await put(sofa.id, { lawTagText: 5 })).statusCode).toBe(400);
    const long = await put(sofa.id, { lawTagText: "x".repeat(1001) });
    expect(long.statusCode).toBe(400);
    expect(long.body.error).toMatch(/under 1000/);
  });

  it("the database refuses a was price at or below zero", async () => {
    await expect(
      prisma.product.update({ where: { id: sofa.id }, data: { wasPrice: 0 } }),
    ).rejects.toThrow();
  });
});

describe("the picture on a tag", () => {
  const dir = path.join(UPLOAD_ROOT, "images", "products");
  const name = `tag-test-${process.pid}.png`;
  const file = path.join(dir, name);
  const url = `/uploads/images/products/${name}`;

  beforeAll(async () => {
    fs.mkdirSync(dir, { recursive: true });
    // Left half black, right half white, 20 wide by 10 tall.
    const raw = Buffer.alloc(20 * 10 * 3, 255);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) raw.fill(0, (y * 20 + x) * 3, (y * 20 + x + 1) * 3);
    }
    await sharp(raw, { raw: { width: 20, height: 10, channels: 3 } })
      .png()
      .toFile(file);
  });

  afterAll(() => {
    fs.rmSync(file, { force: true });
  });

  /** Reads a ^GFA field back into its rows of bits, as a printer would. */
  function decode(zpl: string): { rowBytes: number; rows: string[] } {
    const [, total, , rowBytes, hex] = /\^GFA,(\d+),(\d+),(\d+),([0-9A-F]+)/.exec(zpl)!.slice(0);
    const perRow = Number(rowBytes);
    expect(hex.length).toBe(Number(total) * 2);
    const rows: string[] = [];
    for (let i = 0; i < hex.length; i += perRow * 2) {
      rows.push(
        hex
          .slice(i, i + perRow * 2)
          .split("")
          .map((h) => Number.parseInt(h, 16).toString(2).padStart(4, "0"))
          .join(""),
      );
    }
    return { rowBytes: perRow, rows };
  }

  it("turns a real file into dots that read back as the same picture", async () => {
    const graphic = await photoField(url, 100);
    expect(graphic).toBeInstanceOf(ZplGraphic);
    const { rowBytes, rows } = decode(String(graphic));
    expect(rowBytes).toBe(3);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.slice(0, 10)).toBe("1".repeat(10));
      expect(row.slice(10, 20)).toBe("0".repeat(10));
    }
  });

  it("shrinks to the template's size, keeping its shape, and never enlarges", async () => {
    const small = decode(String(await photoField(url, 10)));
    expect(small.rows).toHaveLength(5);
    expect(small.rowBytes).toBe(2);
    const big = decode(String(await photoField(url, 1000)));
    expect(big.rows).toHaveLength(10);
  });

  it("doesn't try to read a picture at another address", async () => {
    const warn = jest.spyOn(logger, "warn");
    expect(await photoField("https://example.com/a.png", 100)).toBe("");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is empty with no size, no picture, one elsewhere, or one that can't be read", async () => {
    expect(await photoField(url, null)).toBe("");
    expect(await photoField(null, 100)).toBe("");
    expect(await photoField("https://example.com/a.png", 100)).toBe("");
    expect(await photoField("/uploads/images/products/not-there.png", 100)).toBe("");
  });

  it("goes on a tag where the template puts it, and a template with no size reads no file", async () => {
    await prisma.product.update({ where: { id: sofa.id }, data: { imageUrl: url } });
    await prisma.labelTemplate.update({
      where: { id: priceTemplate.id },
      data: { zplTemplate: "^XA^FO10,10{{photo}}^FS^XZ", photoDots: 100 },
    });
    await post(printHandler, { productId: sofa.id });
    await settled();
    expect(printerAtMill.received()).toMatch(/^\^XA\^FO10,10\^GFA,30,30,3,[0-9A-F]+\^FS\^XZ$/);

    await prisma.labelTemplate.update({
      where: { id: priceTemplate.id },
      data: { photoDots: null },
    });
    const res = await post(printHandler, { productId: sofa.id });
    expect(res.statusCode).toBe(200);
    await settled();
    expect(printerAtMill.received().endsWith("^XA^FO10,10^FS^XZ")).toBe(true);
  });

  it("a tag still prints when its picture can't be read", async () => {
    await prisma.product.update({
      where: { id: sofa.id },
      data: { imageUrl: "/uploads/images/products/not-there.png" },
    });
    await prisma.labelTemplate.update({
      where: { id: priceTemplate.id },
      data: { zplTemplate: "^XA^FD{{name}}^FS^FO1,1{{photo}}^FS^XZ", photoDots: 100 },
    });
    const res = await post(printHandler, { productId: sofa.id });
    expect(res.statusCode).toBe(200);
    await settled();
    expect(printerAtMill.received()).toContain("^FDSofa^FS");
  });
});

describe("the template screen's routes", () => {
  beforeEach(async () => {
    await makeStaff("sam", "SUPER_ADMIN");
    signIn("sam");
  });

  const fields = { name: "T", context: "PRODUCT", tagSize: "4x6", zplTemplate: "^XA^XZ" };

  it("saves a photo size on a new template and an edit, and clears it", async () => {
    const made = await post(labelsHandler, { ...fields, photoDots: 200 });
    expect(made.statusCode).toBe(201);
    const id = (made.body as unknown as { id: number }).id;
    expect((await prisma.labelTemplate.findUniqueOrThrow({ where: { id } })).photoDots).toBe(200);

    const edit = await post(
      templateHandler,
      { ...fields, photoDots: 300 },
      { id: String(id) },
      "PUT",
    );
    expect(edit.statusCode).toBe(200);
    expect((await prisma.labelTemplate.findUniqueOrThrow({ where: { id } })).photoDots).toBe(300);

    await post(templateHandler, { ...fields, photoDots: null }, { id: String(id) }, "PUT");
    expect((await prisma.labelTemplate.findUniqueOrThrow({ where: { id } })).photoDots).toBeNull();
  });

  it("the shared route's edit saves it too", async () => {
    const made = await post(labelsHandler, fields);
    const id = (made.body as unknown as { id: number }).id;
    const edit = await post(labelsHandler, { ...fields, id, photoDots: 150 }, {}, "PUT");
    expect(edit.statusCode).toBe(200);
    expect((await prisma.labelTemplate.findUniqueOrThrow({ where: { id } })).photoDots).toBe(150);
  });

  it.each([0, 2001, 1.5, "200"])(
    "refuses a photo size of %p, on every route",
    async (photoDots) => {
      const made = await post(labelsHandler, { ...fields, photoDots });
      expect(made.statusCode).toBe(400);
      expect(made.body.error).toMatch(/whole number of dots/);
      const id = priceTemplate.id;
      const edit = await post(templateHandler, { ...fields, photoDots }, { id: String(id) }, "PUT");
      expect(edit.statusCode).toBe(400);
      const shared = await post(labelsHandler, { ...fields, id, photoDots }, {}, "PUT");
      expect(shared.statusCode).toBe(400);
    },
  );

  it("the database refuses what the routes would", async () => {
    await expect(
      prisma.labelTemplate.update({ where: { id: priceTemplate.id }, data: { photoDots: 0 } }),
    ).rejects.toThrow();
  });
});

describe("the sold tag", () => {
  const line = (n: number) => order.lineItems[n].id;
  const sold = (lineItemId: unknown, id: number = order.id) =>
    post(soldHandler, { lineItemId }, { id: String(id) });

  beforeEach(async () => {
    await template("SOLD", "^XA^FDSOLD {{customerLastName}} {{orderNumber}} {{name}}^FS^XZ");
  });

  it("prints the sale's details on a printer at the order's store", async () => {
    const res = await sold(line(0));
    expect(res.statusCode).toBe(200);
    await settled();
    expect(printerAtMill.received()).toBe("^XA^FDSOLD Ames SO-1 Sofa^FS^XZ");
  });

  it("refuses a cancelled line and a zero-quantity one", async () => {
    expect((await sold(line(1))).body.error).toMatch(/no longer on the order/);
    expect((await sold(line(2))).body.error).toMatch(/nothing on it/);
    await settled();
    expect(printerAtMill.received()).toBe("");
  });

  it("refuses a quote: nothing has sold", async () => {
    await prisma.salesOrder.update({ where: { id: order.id }, data: { status: "QUOTE" } });
    const res = await sold(line(0));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/sold order/);
  });

  it("refuses a line from another order", async () => {
    const other = await prisma.salesOrder.create({
      data: {
        orderno: "SO-2",
        status: "ORDER",
        orderDate: new Date(),
        lineItems: {
          create: [{ lineNumber: 1, productId: sofa.id, orderedQuantity: 1, netPrice: 1, cost: 1 }],
        },
      } as never,
    });
    const res = await sold(line(0), other.id);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/isn't on this order/);
  });

  it("says what's missing: the order, a template, a printer at its store", async () => {
    expect((await sold(line(0), 999999)).statusCode).toBe(404);
    expect((await sold("soon")).statusCode).toBe(400);

    await prisma.salesOrder.update({
      where: { id: order.id },
      data: { storeLocation: "Dock", storeLocationId: null },
    });
    const noPrinter = await sold(line(0));
    expect(noPrinter.statusCode).toBe(400);
    expect(noPrinter.body.error).toMatch(/at Dock/);

    await prisma.labelTemplate.deleteMany({ where: { context: "SOLD" } });
    const noTemplate = await sold(line(0));
    expect(noTemplate.statusCode).toBe(400);
    expect(noTemplate.body.error).toMatch(/No label template for SOLD/);
  });

  it("only takes a POST", async () => {
    const res = await post(soldHandler, {}, { id: String(order.id) }, "GET");
    expect(res.statusCode).toBe(405);
  });
});

describe("the receiving screen", () => {
  it("is told each line's product, or it can't offer to print that line's tag", async () => {
    const vendor = await prisma.vendor.findFirstOrThrow();
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PO-TAG",
        vendorId: vendor.id,
        lineItems: {
          create: [{ productId: sofa.id, orderedQuantity: 1, unitCost: 500 }],
        },
      } as never,
    });
    const res = await post(purchaseOrderHandler, undefined, { id: String(po.id) }, "GET");
    expect(res.statusCode).toBe(200);
    expect(
      (res.body as unknown as { lineItems: { productId: number }[] }).lineItems[0].productId,
    ).toBe(sofa.id);
  });
});

describe("printing from receiving in a batch", () => {
  it("keeps tags to the receiving store's printers", async () => {
    const dock = await prisma.storeLocation.findFirstOrThrow({ where: { code: "DOCK" } });
    const atDock = await post(batchHandler, {
      items: [{ productId: sofa.id, copies: 1 }],
      storeLocationId: dock.id,
    });
    expect(atDock.statusCode).toBe(200);
    expect(atDock.body).toMatchObject({
      results: [{ success: false, error: expect.stringMatching(/at Dock/) }],
    });
    await settled();
    expect(printerAtMill.received()).toBe("");

    const atMill = await post(batchHandler, {
      items: [{ productId: sofa.id, copies: 2 }],
      storeLocationId: mill.id,
    });
    expect(atMill.body).toMatchObject({ results: [{ success: true, printer: "Mill Zebra" }] });
    await settled();
    expect(printerAtMill.received().match(/\^XA/g)).toHaveLength(2);
  });

  it("refuses a store that doesn't exist, and still works with none named", async () => {
    const bad = await post(batchHandler, {
      items: [{ productId: sofa.id }],
      storeLocationId: 999999,
    });
    expect(bad.statusCode).toBe(400);
    const none = await post(batchHandler, { items: [{ productId: sofa.id }] });
    expect(none.body).toMatchObject({ results: [{ success: true }] });
  });
});

describe("how someone prints tags", () => {
  function account(userId: string) {
    const ctx: TrpcContext = {
      userId,
      userEmail: `${userId}@example.com`,
      tokenRole: null,
      impersonate: null,
      headers: new Headers(),
    };
    return createCallerFactory(appRouter)(ctx).account;
  }

  it("is one at a time until they choose, then remembered, per person", async () => {
    expect((await account("wes").me()).tagPrintMode).toBe("ONE_AT_A_TIME");
    await account("wes").setTagPrintMode({ mode: "BATCH" });
    expect((await account("wes").me()).tagPrintMode).toBe("BATCH");
    expect((await account("mia").me()).tagPrintMode).toBe("ONE_AT_A_TIME");
    await account("wes").setTagPrintMode({ mode: "ONE_AT_A_TIME" });
    expect((await account("wes").me()).tagPrintMode).toBe("ONE_AT_A_TIME");
  });

  it("refuses a mode that doesn't exist, and the database does too", async () => {
    await expect(account("wes").setTagPrintMode({ mode: "LATER" as never })).rejects.toThrow();
    await expect(
      prisma.staffMember.updateMany({ data: { tagPrintMode: "LATER" } }),
    ).rejects.toThrow();
  });
});

describe("who may print", () => {
  /** The route as served: permission gate included, its rate limit stood aside. */
  const served = async (route: string, body: unknown, query: Record<string, string> = {}) => {
    const mod = await import(route);
    return post(mod.default, body, query);
  };

  it("anyone who can receive or works the floor can print a tag, others can't", async () => {
    for (const who of ["mia", "wes", "bea"]) {
      signIn(who);
      const ok = await served("@/pages/api/print-label", { productId: sofa.id });
      expect({ who, status: ok.statusCode }).toEqual({ who, status: 200 });
    }
    for (const who of ["dana", "mark"]) {
      signIn(who);
      const no = await served("@/pages/api/print-label", { productId: sofa.id });
      expect({ who, status: no.statusCode }).toEqual({ who, status: 403 });
      const batch = await served("@/pages/api/print-label/batch", {
        items: [{ productId: sofa.id }],
      });
      expect({ who, status: batch.statusCode }).toEqual({ who, status: 403 });
    }
  });

  it("anyone who sells or works the floor can print a sold tag, others can't", async () => {
    await template("SOLD", "^XA^XZ");
    const body = { lineItemId: order.lineItems[0].id };
    const query = { id: String(order.id) };
    for (const who of ["dana", "wes"]) {
      signIn(who);
      const ok = await served("@/pages/api/sales/orders/[id]/sold-tag", body, query);
      expect({ who, status: ok.statusCode }).toEqual({ who, status: 200 });
    }
    signIn("mark");
    const no = await served("@/pages/api/sales/orders/[id]/sold-tag", body, query);
    expect(no.statusCode).toBe(403);
  });

  it("the product page offers printing to those who can, and not to others", async () => {
    const pageAs = async (userId: string) => {
      (getToken as jest.Mock).mockResolvedValue({ id: userId });
      (headers as jest.Mock).mockResolvedValue(new Headers());
      (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
      const page = await ProductDetailPage({ params: Promise.resolve({ id: String(sofa.id) }) });
      return page.props;
    };
    expect((await pageAs("mia")).canPrintTags).toBe(true);
    expect((await pageAs("bea")).canPrintTags).toBe(true);
    expect((await pageAs("wes")).canPrintTags).toBe(true);
    expect((await pageAs("dana")).canPrintTags).toBe(false);
    // Holds warehouse.operate without purchasing.receive, and may read the catalog
    // here because its role was given that.
    await makeStaff("dee", "DISPATCH");
    const dispatch = await prisma.role.findUniqueOrThrow({ where: { key: "DISPATCH" } });
    await prisma.rolePermission.create({
      data: { roleId: dispatch.id, permission: "catalog.read" },
    });
    await prisma.role.update({ where: { id: dispatch.id }, data: { grantsCustomized: true } });
    invalidateRoleGrantCache();
    expect((await pageAs("dee")).canPrintTags).toBe(true);
  });
});
