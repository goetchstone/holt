// /app/__tests__/integration/reimportsFailClosed.integration.test.ts
//
// Importing a vendor's document a second time, against the real database.
//
// The two purchase-order uploads used to delete whatever PO held the document's
// number and write a new one, and the proposal upload deleted the lines of
// whatever sale held its number. What that destroyed depends on foreign keys
// (a freight charge cascades away, a sale line's link goes with its PO line, a
// receipt blocks the delete), so it is only visible in real rows.
//
// Real routes, permission gates and database. Stood in for: the session, the
// multipart form, and the three PDF parsers, which are not under test: the PO
// or quote they feed is.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("@/lib/pricing/nuorderParser", () => ({ parseNuOrderPDF: jest.fn() }));
jest.mock("@/lib/pricing/zSupplyParser", () => ({ parseZSupplyPDF: jest.fn() }));
jest.mock("@/lib/pricing/hdProposalParser", () => ({ parseHDProposal: jest.fn() }));
jest.mock("@/lib/secureUpload", () => ({
  ...jest.requireActual("@/lib/secureUpload"),
  createSecureForm: jest.fn(),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { parseNuOrderPDF, type NuOrderPO } from "@/lib/pricing/nuorderParser";
import { parseZSupplyPDF, type ZSupplyInvoice } from "@/lib/pricing/zSupplyParser";
import { parseHDProposal, type HDProposal } from "@/lib/pricing/hdProposalParser";
import { createSecureForm } from "@/lib/secureUpload";
import orderConfirmationRoute from "@/pages/api/purchasing/import-nuorder";
import invoiceRoute from "@/pages/api/purchasing/import-zsupply";
import proposalRoute from "@/pages/api/sales/import-hd-proposal";

const sessionMock = getServerSession as jest.Mock;

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

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function post(route: Route, body: unknown = {}): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method: "POST", query: {}, body, cookies: {}, headers: {} } as any;
  await route(req, res);
  return res;
}

let dir = "";
let departmentId = 0;
let categoryId = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reimport-"));
  fs.writeFileSync(path.join(dir, "upload.pdf"), "not parsed");
});

afterAll(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles();
  invalidateRoleGrantCache();
  await prisma.user.create({ data: { id: "buyer", email: "buyer@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.staffMember.create({
    data: { userId: "buyer", displayName: "Buyer", role: "ADMIN", roleId: role.id },
  });
  sessionMock.mockResolvedValue({ user: { id: "buyer", email: "buyer@example.com" } });

  const department = await prisma.department.create({ data: { name: "Apparel" } });
  const category = await prisma.category.create({
    data: { name: "Tops", departmentId: department.id },
  });
  departmentId = department.id;
  categoryId = category.id;
  // The multipart form: the route's fields, and one file on disk.
  (createSecureForm as jest.Mock).mockReturnValue({
    parse: (_req: unknown, done: (err: unknown, fields: unknown, files: unknown) => void) =>
      done(
        null,
        { departmentId: [String(departmentId)], categoryId: [String(categoryId)] },
        { file: [{ filepath: path.join(dir, "upload.pdf") }] },
      ),
  });
});

/** An order confirmation for PO 70001 from Sample Brand: one style, sizes S and M. */
function confirmation(over: Partial<NuOrderPO> = {}): NuOrderPO {
  return {
    vendorName: "Sample Brand",
    orderNumber: "9000001",
    poNumber: "70001",
    orderDate: "JAN 05, 2026",
    deliveryStart: "",
    deliveryEnd: "",
    terms: "",
    buyerName: "",
    buyerEmail: "",
    totalUnits: 3,
    totalPrice: 115.5,
    items: [
      {
        productName: "The Easy Tee",
        styleNumber: "ET100",
        msrp: 98,
        season: "",
        color: "black",
        colorCode: "BLK",
        unitPrice: 38.5,
        totalUnits: 3,
        totalPrice: 115.5,
        sizes: [
          { size: "S", quantity: 1 },
          { size: "M", quantity: 2 },
        ],
      },
    ],
    warnings: [],
    ...over,
  };
}

/** The same confirmation, revised by the vendor: one more of size M. */
const revised = () =>
  confirmation({
    totalUnits: 4,
    items: [
      {
        ...confirmation().items[0],
        totalUnits: 4,
        sizes: [
          { size: "S", quantity: 1 },
          { size: "M", quantity: 3 },
        ],
      },
    ],
  });

async function importConfirmation(doc: NuOrderPO): Promise<TestRes> {
  (parseNuOrderPDF as jest.Mock).mockResolvedValue(doc);
  return post(orderConfirmationRoute);
}

const poByNumber = (poNumber: string) =>
  prisma.purchaseOrder.findUniqueOrThrow({
    where: { poNumber },
    include: { lineItems: { orderBy: { id: "asc" } }, charges: true, vendor: true },
  });

describe("importing a vendor's order document again", () => {
  it("replaces the lines of the same PO in place, keeping the row and what hangs off it", async () => {
    expect((await importConfirmation(confirmation())).statusCode).toBe(200);
    const first = await poByNumber("70001");
    // The store has built on the PO since: a ship-to, a note and a freight charge.
    const store = await prisma.storeLocation.create({
      data: { name: "Main Street", code: "MS", type: "STORE" },
    });
    await prisma.purchaseOrder.update({
      where: { id: first.id },
      data: { shipToLocationId: store.id, notes: "Dock door 2" },
    });
    await prisma.purchaseOrderCharge.create({
      data: { purchaseOrderId: first.id, description: "Freight", amount: 42, splitBy: "VALUE" },
    });

    const again = await importConfirmation(revised());

    expect(again.statusCode).toBe(200);
    expect(again.body).toMatchObject({ poId: first.id, replaced: true, itemCount: 2 });
    const now = await poByNumber("70001");
    expect(now.id).toBe(first.id);
    expect(now.lineItems.map((l) => [l.partNo, Number(l.orderedQuantity)])).toEqual([
      ["ET100-BLK-S", 1],
      ["ET100-BLK-M", 3],
    ]);
    // Deleting the PO took the charge with it and dropped the ship-to and note.
    expect(now.charges.map((c) => Number(c.amount))).toEqual([42]);
    expect(now.shipToLocationId).toBe(store.id);
    expect(now.notes).toBe("Dock door 2");
    expect(await prisma.purchaseOrder.count()).toBe(1);
  });

  it("refuses a PO goods have been received against, and says so", async () => {
    await importConfirmation(confirmation());
    const po = await poByNumber("70001");
    await prisma.receivingRecord.create({
      data: {
        purchaseOrderId: po.id,
        purchaseOrderItemId: po.lineItems[0].id,
        quantityReceived: 1,
        receiverUserId: "buyer",
      },
    });

    const again = await importConfirmation(revised());

    // It answered 500 "Import failed" before: the database refused the delete.
    expect(again.statusCode).toBe(409);
    expect(again.body.error).toMatch(/PO 70001 was not replaced.*received against it/);
    const now = await poByNumber("70001");
    expect(now.lineItems.map((l) => Number(l.orderedQuantity))).toEqual([1, 2]);
  });

  it("refuses another vendor's PO that holds the number, and leaves it whole", async () => {
    const other = await prisma.vendor.create({ data: { name: "Other Mills" } });
    const theirs = await prisma.purchaseOrder.create({
      data: {
        poNumber: "70001",
        vendorId: other.id,
        status: "SUBMITTED",
        lineItems: { create: [{ partNo: "OM-1", productName: "Bolt", orderedQuantity: 5 }] },
        charges: { create: [{ description: "Duty", amount: 18, splitBy: "VALUE" }] },
      },
    });

    const res = await importConfirmation(confirmation());

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe(
      "PO 70001 was not replaced, and nothing was changed: that number belongs to a Other Mills PO, and this document is from Sample Brand.",
    );
    const now = await poByNumber("70001");
    expect(now).toMatchObject({ id: theirs.id, vendorId: other.id, status: "SUBMITTED" });
    expect(now.lineItems.map((l) => l.partNo)).toEqual(["OM-1"]);
    expect(now.charges).toHaveLength(1);
    // Refused before anything was written: no product came from the document.
    expect(await prisma.product.count()).toBe(0);
  });

  it("refuses a cancelled PO instead of bringing it back confirmed", async () => {
    await importConfirmation(confirmation());
    await prisma.purchaseOrder.update({
      where: { poNumber: "70001" },
      data: { status: "CANCELLED" },
    });

    const again = await importConfirmation(revised());

    expect(again.statusCode).toBe(409);
    expect(again.body.error).toMatch(/closed and can't be changed/);
    expect((await poByNumber("70001")).status).toBe("CANCELLED");
  });

  it("refuses a PO with a line ordered for a customer's sale, and keeps the link", async () => {
    await importConfirmation(confirmation());
    const po = await poByNumber("70001");
    const customer = await prisma.customer.create({
      data: { firstName: "Dana", lastName: "Reed" },
    });
    const sale = await prisma.salesOrder.create({
      data: {
        orderno: "SO-1",
        status: "ORDER",
        orderDate: new Date("2026-11-01"),
        customerId: customer.id,
        lineItems: {
          create: [
            { lineNumber: 1, partNo: "ET100-BLK-S", netPrice: 98, cost: 38.5, orderedQuantity: 1 },
          ],
        },
      },
      include: { lineItems: true },
    });
    await prisma.purchaseOrderItem.update({
      where: { id: po.lineItems[0].id },
      data: { orderLineItemId: sale.lineItems[0].id },
    });

    const again = await importConfirmation(revised());

    expect(again.statusCode).toBe(409);
    expect(again.body.error).toMatch(/raised for a customer's sale/);
    const line = await prisma.purchaseOrderItem.findUniqueOrThrow({
      where: { id: po.lineItems[0].id },
    });
    expect(line.orderLineItemId).toBe(sale.lineItems[0].id);
  });

  it("holds the invoice upload to the same rule", async () => {
    const invoice: ZSupplyInvoice = {
      vendorName: "Z Supply",
      invoiceNumber: "1234567",
      orderNumber: "",
      poNumber: "",
      invoiceDate: "01/05/2026",
      dueDate: "",
      terms: "",
      shipVia: "",
      trackingNumber: "",
      totalUnits: 2,
      totalPrice: 96,
      items: [
        {
          styleNumber: "ZT100",
          colorCode: "BLK",
          productName: "Rib Tank",
          size: "M",
          quantity: 2,
          unitPrice: 48,
          extendedAmount: 96,
        },
      ],
      warnings: [],
    };
    (parseZSupplyPDF as jest.Mock).mockResolvedValue(invoice);
    // Another vendor's open PO happens to carry the invoice's number.
    const other = await prisma.vendor.create({ data: { name: "Other Mills" } });
    const theirs = await prisma.purchaseOrder.create({
      data: { poNumber: "1234567", vendorId: other.id, status: "CONFIRMED" },
    });

    const refused = await post(invoiceRoute);
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toMatch(/belongs to a Other Mills PO/);
    expect((await poByNumber("1234567")).id).toBe(theirs.id);

    // Its own PO: written, then replaced in place with the charge kept.
    await prisma.purchaseOrder.update({
      where: { id: theirs.id },
      data: { poNumber: "OM-1234567" },
    });
    expect((await post(invoiceRoute)).statusCode).toBe(200);
    const own = await poByNumber("1234567");
    await prisma.purchaseOrderCharge.create({
      data: { purchaseOrderId: own.id, description: "Freight", amount: 12, splitBy: "QUANTITY" },
    });
    (parseZSupplyPDF as jest.Mock).mockResolvedValue({
      ...invoice,
      items: [{ ...invoice.items[0], quantity: 5 }],
    });
    const again = await post(invoiceRoute);
    expect(again.body).toMatchObject({ poId: own.id, replaced: true });
    const now = await poByNumber("1234567");
    expect(now.lineItems.map((l) => Number(l.orderedQuantity))).toEqual([5]);
    expect(now.charges).toHaveLength(1);
  });
});

describe("importing a proposal again", () => {
  const proposal: HDProposal = {
    quoteNumber: "77001",
    quoteDate: "10/29/2026",
    validThrough: "11/29/2026",
    salesperson: "",
    sidemark: "",
    customer: { name: "Dana Reed", street: "", cityStateZip: "" },
    items: [
      {
        itemNumber: 1,
        room: "Living",
        description: "Roller shade",
        qty: 1,
        msrp: 1000,
        each: 1000,
        extended: 1000,
        freight: 0,
        install: 0,
      },
    ],
    totalFreight: 0,
    totalInstall: 0,
    msrpTotal: 1000,
    discountTotal: 0,
    clientPrice: 1000,
    warnings: [],
  };
  const revisedProposal: HDProposal = {
    ...proposal,
    items: [{ ...proposal.items[0], each: 1400, extended: 1400 }],
    clientPrice: 1400,
  };
  const pdfBase64 = Buffer.from("not parsed").toString("base64");

  const importProposal = (doc: HDProposal) => {
    (parseHDProposal as jest.Mock).mockResolvedValue(doc);
    return post(proposalRoute, { pdfBase64 });
  };
  const quote = () =>
    prisma.salesOrder.findUniqueOrThrow({
      where: { orderno: "HD-77001" },
      include: { lineItems: { orderBy: { lineNumber: "asc" } } },
    });

  it("refreshes the quote while it is still a quote", async () => {
    expect((await importProposal(proposal)).statusCode).toBe(200);
    expect((await importProposal(revisedProposal)).statusCode).toBe(200);
    const now = await quote();
    expect(now.status).toBe("QUOTE");
    expect(now.lineItems.map((l) => Number(l.netPrice))).toEqual([1400]);
  });

  it("refuses once the quote has become a sale, and leaves its lines and payment alone", async () => {
    await importProposal(proposal);
    const sale = await quote();
    await prisma.salesOrder.update({ where: { id: sale.id }, data: { status: "ORDER" } });
    await prisma.orderLineItem.update({
      where: { id: sale.lineItems[0].id },
      data: { fulfilledQty: 1 },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: sale.id,
        customerId: sale.customerId,
        paymentDate: new Date(),
        paymentType: "Check",
        method: "CHECK",
        paymentAmount: 500,
        status: "COMPLETED",
      },
    });

    const again = await importProposal(revisedProposal);

    expect(again.statusCode).toBe(409);
    expect(again.body.error).toBe(
      "HD-77001 is no longer a quote, so the proposal was not imported over it and nothing was changed. Change the sale on its own page.",
    );
    const now = await quote();
    // The same row, as delivered: not a new line at the revised price with
    // nothing delivered.
    expect(now.lineItems.map((l) => [l.id, Number(l.netPrice), Number(l.fulfilledQty)])).toEqual([
      [sale.lineItems[0].id, 1000, 1],
    ]);
    expect(await prisma.payment.count({ where: { salesOrderId: sale.id } })).toBe(1);
  });
});
