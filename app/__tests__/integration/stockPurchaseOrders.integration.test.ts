// /app/__tests__/integration/stockPurchaseOrders.integration.test.ts
//
// GAP-01: a buyer writes a stock purchase order by hand, changes it until
// goods arrive, duplicates it, prints it and emails it to the vendor.
//
// Real routes, real permission gates, real database. next-auth's session is the
// only mock. Email goes over a real SMTP conversation to a sink on localhost,
// so the attachment asserted is the one that was actually sent.

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
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { extractPdfText } from "@/lib/pricing/pdfUtils";
import { onPaymentReceived } from "@/lib/paymentService";
import ordersRoute from "@/pages/api/purchasing/orders/index";
import orderRoute from "@/pages/api/purchasing/orders/[id]";
import editRoute from "@/pages/api/purchasing/orders/[id]/edit";
import duplicateRoute from "@/pages/api/purchasing/orders/[id]/duplicate";
import pdfRoute from "@/pages/api/purchasing/orders/[id]/pdf";
import emailRoute from "@/pages/api/purchasing/orders/[id]/email";
import vendorProductsRoute from "@/pages/api/purchasing/vendor-products";
import { startSmtpSink } from "../helpers/smtpSink";

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  raw: Buffer | null;
  headers: Record<string, unknown>;
}

async function call(
  route: Route,
  userId: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: object; body?: object } = {},
): Promise<Reply> {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
  });
  let status = 200;
  let payload: unknown = null;
  let raw: Buffer | null = null;
  const headers: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(p: unknown) {
      payload = p;
      return this;
    },
    send(p: unknown) {
      if (Buffer.isBuffer(p)) raw = p;
      else payload = p;
      return this;
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  await route({ method, query, body, cookies: {} } as unknown as NextApiRequest, res);
  return { status, body: JSON.parse(JSON.stringify(payload)), raw, headers };
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

const w = {} as {
  fern: { id: number };
  quarry: { id: number };
  sofa: { id: number };
  chair: { id: number };
  lamp: { id: number };
  stool: { id: number };
  warehouse: { id: number };
  shut: { id: number };
};

const PO_NUMBER = /^PO-\d{6}-\d{3}$/;

/** A message as its reader sees it: SMTP dot-stuffing, quoted-printable soft breaks and escapes undone. */
const unquoted = (raw: string) =>
  raw
    .replace(/^\.\./gm, ".")
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Co", slug: "test-co" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, companyName: "Linden Row Home", timezone: "UTC" },
  });
  invalidateAppSettingsCache();

  // An admin on file, so the bootstrap safeguard (no privileged staff yet:
  // everyone admitted) is off and each refusal below is a real one.
  await makeStaff("ada", "ADMIN");
  await makeStaff("bea", "BUYER");
  await makeStaff("wes", "WAREHOUSE");
  await makeStaff("dee", "DESIGNER");
  // A custom role that writes POs without seeing cost.
  await prisma.role.create({
    data: {
      key: "ORDER_CLERK",
      name: "Order clerk",
      isSystem: false,
      permissions: {
        create: ["purchasing.read", "purchasing.write"].map((permission) => ({ permission })),
      },
    },
  });
  await makeStaff("oli", "ORDER_CLERK", "DATA_ENTRY");

  const dept = await prisma.department.create({ data: { name: "Living" } });
  const cat = await prisma.category.create({ data: { name: "Seating", departmentId: dept.id } });
  w.fern = await prisma.vendor.create({
    data: {
      name: "Fernbrook Upholstery",
      leadTimeDays: 30,
      accountNumber: "FB-2207",
      paymentTerms: "Net 30",
      contacts: {
        create: [
          { name: "Sales desk", email: "sales@fernbrook.test", isPrimary: false },
          { name: "Orders", email: "orders@fernbrook.test", isPrimary: true },
        ],
      },
    },
  });
  w.quarry = await prisma.vendor.create({ data: { name: "Quarry Hill" } });
  const product = (vendorId: number, n: string, cost: number, extra = {}) =>
    prisma.product.create({
      data: {
        productNumber: n,
        name: n.replace("FB-", "Ashby ").replace("QH-", "Quarry "),
        vendorId,
        baseCost: cost,
        departmentId: dept.id,
        categoryId: cat.id,
        ...extra,
      },
    });
  w.sofa = await product(w.fern.id, "FB-SOFA", 812);
  w.chair = await product(w.fern.id, "FB-CHAIR", 400);
  w.stool = await product(w.fern.id, "FB-STOOL", 90, { isDiscontinued: true });
  w.lamp = await product(w.quarry.id, "QH-LAMP", 60);
  w.warehouse = await prisma.storeLocation.create({
    data: {
      name: "Linden Row Warehouse",
      code: "WH",
      type: "WAREHOUSE",
      address: "400 Depot Street",
      city: "Springfield",
      state: "IL",
      zip: "62701",
    },
  });
  w.shut = await prisma.storeLocation.create({
    data: { name: "Old Annex", code: "OA", type: "STORE", isActive: false },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const newPo = (over: object = {}) => ({
  vendorId: w.fern.id,
  shipToLocationId: w.warehouse.id,
  expectedDelivery: "2026-12-01",
  notes: "Dock door 2",
  lines: [
    { productId: w.sofa.id, quantity: 2, unitCost: 800 },
    { productId: w.chair.id, quantity: 4 },
  ],
  ...over,
});

async function create(userId = "bea", over: object = {}) {
  const r = await call(ordersRoute, userId, { method: "POST", body: newPo(over) });
  expect(r.status).toBe(201);
  return r.body as { id: number; poNumber: string };
}

const linesOf = (purchaseOrderId: number) =>
  prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId }, orderBy: { id: "asc" } });

describe("writing a stock PO", () => {
  it("creates a numbered draft for the vendor, shipping where the buyer said", async () => {
    const { id, poNumber } = await create();
    expect(poNumber).toMatch(PO_NUMBER);
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } });
    expect(po).toMatchObject({
      vendorId: w.fern.id,
      shipToLocationId: w.warehouse.id,
      status: "DRAFT",
      salesOrderId: null,
      notes: "Dock door 2",
      createdBy: "bea@example.com",
    });
    expect(po.expectedDelivery?.toISOString().slice(0, 10)).toBe("2026-12-01");
    const lines = await linesOf(id);
    expect(
      lines.map((l) => [l.partNo, l.productName, Number(l.orderedQuantity), Number(l.unitCost)]),
    ).toEqual([
      ["FB-SOFA", "Ashby SOFA", 2, 800],
      // No cost sent: the catalog's.
      ["FB-CHAIR", "Ashby CHAIR", 4, 400],
    ]);
  });

  it("refuses a product another vendor supplies, and writes nothing", async () => {
    const before = await prisma.purchaseOrder.count();
    const r = await call(ordersRoute, "bea", {
      method: "POST",
      body: newPo({ lines: [{ productId: w.lamp.id, quantity: 1 }] }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(
      "Line 1: Quarry LAMP isn't one of Fernbrook Upholstery's products. Set its vendor on the product first.",
    );
    expect(await prisma.purchaseOrder.count()).toBe(before);
  });

  it.each([
    [{ shipToLocationId: -1 }, "Choose where the vendor delivers."],
    [{ lines: [] }, "Add at least one line."],
    [{ vendorId: undefined }, "Choose a vendor."],
  ])("refuses a body that can't be a PO: %j", async (over, error) => {
    const r = await call(ordersRoute, "bea", { method: "POST", body: newPo(over) });
    expect(r).toMatchObject({ status: 400, body: { error } });
  });

  it("refuses a closed store as the ship-to", async () => {
    const r = await call(ordersRoute, "bea", {
      method: "POST",
      body: newPo({ shipToLocationId: w.shut.id }),
    });
    expect(r).toMatchObject({
      status: 400,
      body: { error: "Choose an open store or warehouse for the vendor to deliver to." },
    });
  });

  it("is for Write purchase orders: the warehouse, which only receives, is refused", async () => {
    const r = await call(ordersRoute, "wes", { method: "POST", body: newPo() });
    expect(r.status).toBe(403);
  });

  it("a writer without View cost still writes POs, at the catalog's cost whatever is sent", async () => {
    const { id } = await create("oli", {
      lines: [{ productId: w.sofa.id, quantity: 1, unitCost: 1 }],
    });
    const [line] = await linesOf(id);
    expect(Number(line.unitCost)).toBe(812);
  });

  it("numbers POs raised at once without a clash, in one sequence with special orders", async () => {
    const made = await Promise.all([create(), create(), create()]);
    const numbers = made.map((m) => m.poNumber);
    expect(new Set(numbers).size).toBe(3);

    // A special order's draft PO, raised the same day, takes the next number.
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-STOCK-1",
        status: "QUOTE",
        orderDate: new Date(),
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: w.chair.id,
              productName: "Ashby CHAIR",
              orderedQuantity: 1,
              netPrice: 900,
              cost: 400,
              vatRate: 0,
              vatAmount: 0,
              source: "ORDER" as const,
            },
          ],
        },
      },
    });
    await onPaymentReceived(order.id);
    const special = await prisma.purchaseOrder.findFirstOrThrow({
      where: { salesOrderId: order.id },
    });
    const all = await prisma.purchaseOrder.findMany({
      where: { poNumber: { startsWith: special.poNumber.slice(0, 10) } },
      orderBy: { poNumber: "desc" },
      select: { poNumber: true },
    });
    expect(all[0].poNumber).toBe(special.poNumber);
    const seq = (n: string) => Number(n.slice(-3));
    expect(seq(special.poNumber)).toBe(Math.max(...numbers.map(seq)) + 1);
  });
});

describe("the vendor's products for a PO line", () => {
  it("lists that vendor's current products, with cost only for a holder of View cost", async () => {
    const r = await call(vendorProductsRoute, "bea", { query: { vendorId: String(w.fern.id) } });
    expect(r.status).toBe(200);
    expect(r.body.products.map((p: { productNumber: string }) => p.productNumber)).toEqual([
      "FB-CHAIR",
      "FB-SOFA",
    ]);
    expect(r.body.products[0].baseCost).toBe(400);

    const clerk = await call(vendorProductsRoute, "oli", {
      query: { vendorId: String(w.fern.id), search: "sofa" },
    });
    expect(clerk.body).toEqual({
      costVisible: false,
      products: [{ id: w.sofa.id, productNumber: "FB-SOFA", name: "Ashby SOFA" }],
    });
  });
});

describe("changing a PO until goods arrive", () => {
  it("changes quantities and costs, adds and removes lines, and moves the ship-to and date", async () => {
    const { id } = await create();
    const [sofa] = await linesOf(id);
    const r = await call(editRoute, "bea", {
      method: "PUT",
      query: { id: String(id) },
      body: {
        shipToLocationId: w.warehouse.id,
        expectedDelivery: null,
        notes: "",
        lines: [
          { id: sofa.id, productId: w.sofa.id, quantity: 3, unitCost: 790 },
          { productId: w.stool.id, quantity: 6 },
        ],
      },
    });
    expect(r.status).toBe(200);
    const lines = await linesOf(id);
    expect(
      lines.map((l) => [l.id === sofa.id, l.partNo, Number(l.orderedQuantity), Number(l.unitCost)]),
    ).toEqual([
      [true, "FB-SOFA", 3, 790],
      [false, "FB-STOOL", 6, 90],
    ]);
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } });
    expect(po).toMatchObject({ expectedDelivery: null, notes: null, updatedBy: "bea@example.com" });
  });

  it("a writer without View cost keeps each line's cost, and a new line gets the catalog's", async () => {
    const { id } = await create();
    const [sofa] = await linesOf(id);
    const r = await call(editRoute, "oli", {
      method: "PUT",
      query: { id: String(id) },
      body: {
        shipToLocationId: w.warehouse.id,
        lines: [
          { id: sofa.id, productId: w.sofa.id, quantity: 5, unitCost: 1 },
          { productId: w.chair.id, quantity: 1, unitCost: 1 },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect((await linesOf(id)).map((l) => Number(l.unitCost))).toEqual([800, 400]);
  });

  it("refuses once anything is received, and leaves the lines as they were", async () => {
    const { id } = await create();
    const [sofa, chair] = await linesOf(id);
    await prisma.receivingRecord.create({
      data: {
        purchaseOrderId: id,
        purchaseOrderItemId: chair.id,
        receiverUserId: "wes",
        quantityReceived: 1,
      },
    });
    const r = await call(editRoute, "bea", {
      method: "PUT",
      query: { id: String(id) },
      body: {
        shipToLocationId: w.warehouse.id,
        lines: [{ id: sofa.id, productId: w.sofa.id, quantity: 9 }],
      },
    });
    expect(r).toMatchObject({
      status: 409,
      body: { error: "This PO can't be changed: goods have been received against it." },
    });
    expect((await linesOf(id)).map((l) => Number(l.orderedQuantity))).toEqual([2, 4]);

    const detail = await call(orderRoute, "bea", { query: { id: String(id) } });
    expect(detail.body.editProblem).toBe(
      "This PO can't be changed: goods have been received against it.",
    );
  });

  it("refuses a cancelled PO and a vendor return", async () => {
    const { id } = await create();
    await prisma.purchaseOrder.update({ where: { id }, data: { status: "CANCELLED" } });
    const body = {
      shipToLocationId: w.warehouse.id,
      lines: [{ productId: w.sofa.id, quantity: 1 }],
    };
    expect(
      (await call(editRoute, "bea", { method: "PUT", query: { id: String(id) }, body })).status,
    ).toBe(409);
    await prisma.purchaseOrder.update({ where: { id }, data: { status: "DRAFT", isReturn: true } });
    const r = await call(editRoute, "bea", { method: "PUT", query: { id: String(id) }, body });
    expect(r).toMatchObject({
      status: 409,
      body: { error: "A vendor return can't be changed here." },
    });
  });

  it("a line raised for a customer's order keeps its product and quantity; only its cost moves", async () => {
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-LINKED-1",
        status: "ORDER",
        orderDate: new Date(),
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: w.sofa.id,
              productName: "Ashby SOFA",
              orderedQuantity: 1,
              netPrice: 1800,
              cost: 812,
              vatRate: 0,
              vatAmount: 0,
              source: "ORDER" as const,
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    const { id } = await create();
    const [sofa] = await linesOf(id);
    await prisma.purchaseOrderItem.update({
      where: { id: sofa.id },
      data: { orderLineItemId: order.lineItems[0].id },
    });
    const put = (lines: object[]) =>
      call(editRoute, "bea", {
        method: "PUT",
        query: { id: String(id) },
        body: { shipToLocationId: w.warehouse.id, lines },
      });

    expect((await put([{ productId: w.chair.id, quantity: 1 }])).body.error).toBe(
      "A line raised for a customer's order can't be removed.",
    );
    expect((await put([{ id: sofa.id, productId: w.sofa.id, quantity: 7 }])).body.error).toBe(
      "Line 1: a line raised for a customer's order keeps its product and quantity.",
    );
    const ok = await put([{ id: sofa.id, productId: w.sofa.id, quantity: 2, unitCost: 777 }]);
    expect(ok.status).toBe(200);
    const [after] = await linesOf(id);
    expect([Number(after.orderedQuantity), Number(after.unitCost), after.orderLineItemId]).toEqual([
      2,
      777,
      order.lineItems[0].id,
    ]);
  });

  it("is for Write purchase orders", async () => {
    const { id } = await create();
    const r = await call(editRoute, "wes", {
      method: "PUT",
      query: { id: String(id) },
      body: { shipToLocationId: w.warehouse.id, lines: [{ productId: w.sofa.id, quantity: 1 }] },
    });
    expect(r.status).toBe(403);
  });
});

describe("duplicating a PO", () => {
  it("makes a new draft with the vendor, ship-to, notes and lines, at the costs they had", async () => {
    const { id, poNumber } = await create();
    await prisma.purchaseOrder.update({ where: { id }, data: { status: "RECEIVED_FULL" } });
    // A zero-quantity line is a cancelled one (rule 31); a line without a
    // product, and a product the vendor no longer supplies, can't be ordered.
    await prisma.purchaseOrderItem.createMany({
      data: [
        {
          purchaseOrderId: id,
          productId: w.chair.id,
          partNo: "FB-CHAIR",
          orderedQuantity: 0,
          unitCost: 400,
        },
        {
          purchaseOrderId: id,
          partNo: "FB-OLD",
          productName: "Retired settee",
          orderedQuantity: 1,
          unitCost: 300,
        },
        {
          purchaseOrderId: id,
          productId: w.lamp.id,
          partNo: "QH-LAMP",
          orderedQuantity: 2,
          unitCost: 60,
        },
      ],
    });

    const r = await call(duplicateRoute, "bea", { method: "POST", query: { id: String(id) } });
    expect(r.status).toBe(201);
    expect(r.body.poNumber).toMatch(PO_NUMBER);
    expect(r.body.poNumber).not.toBe(poNumber);
    expect(r.body.skipped).toEqual([
      "Retired settee: not a product in the catalog",
      "Quarry LAMP: no longer this vendor's product",
    ]);
    const copy = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(copy).toMatchObject({
      vendorId: w.fern.id,
      shipToLocationId: w.warehouse.id,
      status: "DRAFT",
      notes: "Dock door 2",
      salesOrderId: null,
      createdBy: "bea@example.com",
    });
    // The vendor's lead time from today, not the original's date.
    const days = (copy.expectedDelivery!.getTime() - copy.orderDate.getTime()) / 86_400_000;
    expect(days).toBe(30);
    expect(
      (await linesOf(copy.id)).map((l) => [
        l.partNo,
        Number(l.orderedQuantity),
        Number(l.unitCost),
      ]),
    ).toEqual([
      ["FB-SOFA", 2, 800],
      ["FB-CHAIR", 4, 400],
    ]);
  });

  it("refuses when nothing on the PO can be ordered again", async () => {
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON00042",
        vendorId: w.fern.id,
        lineItems: { create: [{ partNo: "X", productName: "Imported line", orderedQuantity: 1 }] },
      },
    });
    const r = await call(duplicateRoute, "bea", { method: "POST", query: { id: String(po.id) } });
    expect(r).toMatchObject({
      status: 400,
      body: { error: "Nothing on this PO can be ordered again." },
    });
  });
});

describe("the PO screen", () => {
  it("is on View purchasing, so a buyer and a designer can open it, and says where it ships", async () => {
    const { id } = await create();
    for (const who of ["bea", "dee"]) {
      const r = await call(orderRoute, who, { query: { id: String(id) } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        shipTo: { id: w.warehouse.id, name: "Linden Row Warehouse" },
        editProblem: null,
        isReturn: false,
        // The vendor has no address of its own: its primary contact's.
        vendorEmail: "orders@fernbrook.test",
      });
    }
  });

  it("status changes stay with receiving and the buyer; a designer can't make them", async () => {
    const { id } = await create();
    const put = (who: string) =>
      call(orderRoute, who, { method: "PUT", query: { id: String(id) }, body: { notes: who } });
    expect((await put("dee")).status).toBe(403);
    expect((await put("wes")).status).toBe(200);
    expect((await put("oli")).status).toBe(200);
  });
});

describe("the PO as a PDF", () => {
  it("prints the store, the vendor, the ship-to and the live lines with prices", async () => {
    const { id, poNumber } = await create();
    await prisma.purchaseOrderItem.create({
      // A line zeroed out at source prints under its own part number.
      data: {
        purchaseOrderId: id,
        partNo: "FB-CANCELLED",
        productName: "Cancelled ottoman",
        orderedQuantity: 0,
      },
    });
    const r = await call(pdfRoute, "bea", { query: { id: String(id) } });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["content-disposition"]).toBe(`inline; filename="${poNumber}.pdf"`);
    const text = await extractPdfText(r.raw!);
    for (const s of [
      "Linden Row Home",
      poNumber,
      "Fernbrook Upholstery",
      "Our account: FB-2207",
      "Payment terms: Net 30",
      "Linden Row Warehouse",
      "400 Depot Street",
      "Springfield, IL 62701",
      "FB-SOFA",
      "$800.00",
      "$1,600.00",
      // 2 x 800 + 4 x 400
      "$3,200.00",
      "Dock door 2",
    ]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("FB-CANCELLED");
    expect(text).not.toContain("Cancelled ottoman");
  });

  it("prints without prices for someone without View cost", async () => {
    const { id } = await create();
    const r = await call(pdfRoute, "oli", { query: { id: String(id) } });
    expect(r.status).toBe(200);
    const text = await extractPdfText(r.raw!);
    expect(text).toContain("FB-SOFA");
    expect(text).not.toContain("$");
  });
});

describe("emailing the PO to the vendor", () => {
  const SMTP_ENV = ["SMTP_HOST", "SMTP_PORT", "EMAIL_FROM", "SMTP_USER", "SMTP_PASS"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of SMTP_ENV) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of SMTP_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const pointSmtpAt = (port: number) => {
    for (const k of SMTP_ENV) delete process.env[k];
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(port);
    process.env.EMAIL_FROM = "buying@lindenrow.test";
  };

  it("sends the PDF it prints, records the send, and a sent draft becomes Submitted", async () => {
    const sink = await startSmtpSink();
    try {
      pointSmtpAt(sink.port);
      const { id, poNumber } = await create();
      const r = await call(emailRoute, "bea", {
        method: "POST",
        query: { id: String(id) },
        body: { to: " orders@fernbrook.test ", message: "Please ship together." },
      });
      expect(r).toMatchObject({ status: 200, body: { sent: true, to: "orders@fernbrook.test" } });

      expect(sink.received.rcptTo).toEqual([expect.stringContaining("<orders@fernbrook.test>")]);
      const message = sink.received.data[0];
      expect(message).toMatch(
        new RegExp(`^Subject: Purchase order ${poNumber} from Linden Row Home$`, "m"),
      );
      expect(unquoted(message)).toContain("<p>Please ship together.</p>");
      expect(message).toMatch(
        new RegExp(`^Content-Disposition: attachment; filename=${poNumber}\\.pdf$`, "m"),
      );

      const queued = await prisma.emailQueue.findFirstOrThrow({
        where: { templateKey: "purchase-order" },
        orderBy: { id: "desc" },
        include: { attachments: true },
      });
      expect(queued).toMatchObject({
        status: "SENT",
        toAddress: "orders@fernbrook.test",
        createdBy: "bea@example.com",
      });
      // The bytes on the wire are the bytes kept for a retry, and they are the PO.
      const kept = Buffer.from(queued.attachments[0].content);
      expect(message.replace(/\r\n/g, "")).toContain(kept.toString("base64"));
      expect(await extractPdfText(kept)).toContain(poNumber);

      expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } })).status).toBe(
        "SUBMITTED",
      );
    } finally {
      await new Promise<void>((resolve) => sink.server.close(() => resolve()));
    }
  });

  it("a PO already past Submitted keeps its status when it is sent again", async () => {
    const sink = await startSmtpSink();
    try {
      pointSmtpAt(sink.port);
      const { id } = await create();
      await prisma.purchaseOrder.update({ where: { id }, data: { status: "CONFIRMED" } });
      const r = await call(emailRoute, "bea", {
        method: "POST",
        query: { id: String(id) },
        body: { to: "orders@fernbrook.test" },
      });
      expect(r.status).toBe(200);
      expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } })).status).toBe(
        "CONFIRMED",
      );
    } finally {
      await new Promise<void>((resolve) => sink.server.close(() => resolve()));
    }
  });

  it("when the send fails, says so, keeps it queued with its PDF, and the draft stays a draft", async () => {
    // A port nothing listens on.
    const sink = await startSmtpSink();
    const port = sink.port;
    await new Promise<void>((resolve) => sink.server.close(() => resolve()));
    pointSmtpAt(port);
    const { id } = await create();
    const r = await call(emailRoute, "bea", {
      method: "POST",
      query: { id: String(id) },
      body: { to: "orders@fernbrook.test" },
    });
    expect(r).toMatchObject({
      status: 502,
      body: {
        error: "The email couldn't be sent just now. It stays queued and will be tried again.",
      },
    });
    const queued = await prisma.emailQueue.findFirstOrThrow({
      where: { templateKey: "purchase-order" },
      orderBy: { id: "desc" },
      include: { attachments: true },
    });
    expect(queued).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(queued.attachments).toHaveLength(1);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");
  });

  it("refuses when email isn't set up, queueing nothing", async () => {
    for (const k of SMTP_ENV) delete process.env[k];
    const { id } = await create();
    const before = await prisma.emailQueue.count();
    const r = await call(emailRoute, "bea", {
      method: "POST",
      query: { id: String(id) },
      body: { to: "orders@fernbrook.test" },
    });
    expect(r).toMatchObject({
      status: 409,
      body: { error: "Email isn't set up yet. An admin sets it up in Settings → Integrations." },
    });
    expect(await prisma.emailQueue.count()).toBe(before);
  });

  it("refuses an address that isn't one, and a cancelled PO", async () => {
    const sink = await startSmtpSink();
    try {
      pointSmtpAt(sink.port);
      const { id } = await create();
      const bad = await call(emailRoute, "bea", {
        method: "POST",
        query: { id: String(id) },
        body: { to: "fernbrook" },
      });
      expect(bad).toMatchObject({
        status: 400,
        body: { error: "Enter the vendor's email address." },
      });
      await prisma.purchaseOrder.update({ where: { id }, data: { status: "CANCELLED" } });
      const cancelled = await call(emailRoute, "bea", {
        method: "POST",
        query: { id: String(id) },
        body: { to: "orders@fernbrook.test" },
      });
      expect(cancelled).toMatchObject({
        status: 409,
        body: { error: "A cancelled purchase order can't be sent." },
      });
      expect(sink.received.data).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => sink.server.close(() => resolve()));
    }
  });
});
