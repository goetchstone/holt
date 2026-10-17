// /app/__tests__/integration/draftAndProposalQtyFractional.integration.test.ts
//
// A buyer's draft and a B2B proposal keep a part roll's quantity, against real
// Postgres, through the real routes and their permission gates (next-auth's
// session is the only mock):
//
//   - a draft item typed as 12.5 yards is stored and sent back as 12.5, a
//     number, and a buy prices it at 12.5 x cost;
//   - importing a real PO for 12.5 yards drafts 12.5 yards;
//   - a proposal line of 12.5 yards is stored and sent back as 12.5, and
//     converting the proposal orders 12.5 yards and prices the whole line;
//   - a quantity that is not a number is refused with a 400 that says so.

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
import itemsRoute from "@/pages/api/admin/buyer-drafts/items/index";
import itemRoute from "@/pages/api/admin/buyer-drafts/items/[id]";
import buyRoute from "@/pages/api/admin/buyer-drafts/buys/[id]";
import draftPoRoute from "@/pages/api/admin/buyer-drafts/pos/[id]";
import importPoRoute from "@/pages/api/admin/buyer-drafts/import-purchase-order";
import proposalRoute from "@/pages/api/proposals/[id]/index";
import proposalLinesRoute from "@/pages/api/proposals/[id]/line-items/index";
import proposalLineRoute from "@/pages/api/proposals/[id]/line-items/[lineId]/index";
import convertRoute from "@/pages/api/proposals/[id]/convert-to-order";

const sessionMock = getServerSession as jest.Mock;

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

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

async function call(
  route: Route,
  method: string,
  query: Record<string, string>,
  body: unknown = {},
): Promise<TestRes> {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method, query, body, headers: {}, cookies: {} } as any;
  await route(req, res);
  return res;
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await prisma.user.create({ data: { id: "buyer", email: "buyer@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.staffMember.create({
    data: { userId: "buyer", displayName: "Buyer", role: "ADMIN", roleId: role.id },
  });
  sessionMock.mockResolvedValue({ user: { id: "buyer", email: "buyer@example.com" } });
});

async function linenProduct() {
  const vendor = await prisma.vendor.create({ data: { name: "Weaver", code: "WV" } });
  const department = await prisma.department.create({ data: { name: "Textiles" } });
  const category = await prisma.category.create({
    data: { name: "Drapery", departmentId: department.id },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "LINEN-01",
      name: "Belgian Linen",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseRetail: 30,
    },
  });
  return { vendor, product };
}

describe("a buyer's draft keeps a part roll", () => {
  async function draftForBuy() {
    const buy = await prisma.buyerDraftBuy.create({ data: { name: "Spring", year: 2027 } });
    const draftPo = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "Weaver", buyId: buy.id },
    });
    return { buy, draftPo };
  }

  it("stores a typed 12.5 and sends it back as a number", async () => {
    const { draftPo } = await draftForBuy();

    const created = await call(
      itemsRoute,
      "POST",
      {},
      {
        vendorName: "Weaver",
        partNumber: "LINEN-01",
        productName: "Belgian Linen",
        cost: 8,
        retail: 30,
        qty: 12.5,
        draftPoId: draftPo.id,
      },
    );
    expect(created.statusCode).toBe(201);
    expect(created.body.item.qty).toBe(12.5);
    const id = created.body.item.id as number;
    expect((await prisma.buyerDraftItem.findUniqueOrThrow({ where: { id } })).qty.toString()).toBe(
      "12.5",
    );

    const patched = await call(itemRoute, "PATCH", { id: String(id) }, { qty: "12.375" });
    expect(patched.statusCode).toBe(200);
    expect(patched.body.item.qty).toBe(12.375);

    const one = await call(itemRoute, "GET", { id: String(id) });
    expect(one.body.item.qty).toBe(12.375);
    const list = await call(itemsRoute, "GET", {});
    expect(list.body.items[0].qty).toBe(12.375);
    const po = await call(draftPoRoute, "GET", { id: String(draftPo.id) });
    expect(po.body.po.items[0].qty).toBe(12.375);
  });

  it("refuses a qty that is not a number or is negative, and keeps zero", async () => {
    const { draftPo } = await draftForBuy();
    const item = await prisma.buyerDraftItem.create({
      data: {
        vendorName: "Weaver",
        partNumber: "LINEN-01",
        productName: "Belgian Linen",
        cost: 8,
        retail: 30,
        draftPoId: draftPo.id,
      },
    });
    const id = String(item.id);

    expect((await call(itemRoute, "PATCH", { id }, { qty: "lots" })).statusCode).toBe(400);
    expect((await call(itemRoute, "PATCH", { id }, { qty: -1 })).statusCode).toBe(400);
    const zero = await call(itemRoute, "PATCH", { id }, { qty: 0 });
    expect(zero.statusCode).toBe(200);
    expect(zero.body.item.qty).toBe(0);
  });

  it("prices a part roll in the buy's rollup", async () => {
    const { buy, draftPo } = await draftForBuy();
    await prisma.buyerDraftItem.create({
      data: {
        vendorName: "Weaver",
        partNumber: "LINEN-01",
        productName: "Belgian Linen",
        cost: 8,
        retail: 30,
        qty: 12.5,
        draftPoId: draftPo.id,
      },
    });

    const res = await call(buyRoute, "GET", { id: String(buy.id) });
    expect(res.statusCode).toBe(200);
    expect(res.body.rollup.totalSpent).toBe(100);
    expect(res.body.rollup.itemCount).toBe(12.5);
  });

  it("drafts the yards a real PO ordered, not a whole number of them", async () => {
    const { vendor, product } = await linenProduct();
    const buy = await prisma.buyerDraftBuy.create({ data: { name: "Fall", year: 2026 } });
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PO-9001",
        vendorId: vendor.id,
        lineItems: {
          create: [
            {
              productId: product.id,
              partNo: "LINEN-01",
              orderedQuantity: 12.5,
              unitCost: 8,
            },
          ],
        },
      },
    });

    const res = await call(importPoRoute, "POST", {}, { buyId: buy.id, purchaseOrderId: po.id });
    expect(res.statusCode).toBe(201);
    const item = await prisma.buyerDraftItem.findFirstOrThrow({});
    expect(item.qty.toString()).toBe("12.5");
  });
});

describe("a B2B proposal keeps a part roll", () => {
  async function proposal() {
    return prisma.proposal.create({ data: { proposalNumber: "PR-0001" } });
  }

  it("stores a typed 12.5 and sends it back as a number", async () => {
    const p = await proposal();
    const id = String(p.id);

    const added = await call(
      proposalLinesRoute,
      "POST",
      { id },
      {
        itemName: "Belgian Linen",
        cost: 8,
        retailPrice: 30,
        quantity: 12.5,
      },
    );
    expect(added.statusCode).toBe(201);
    expect(added.body.quantity).toBe(12.5);
    const lineId = String(added.body.id);
    expect(
      (
        await prisma.proposalLineItem.findUniqueOrThrow({ where: { id: added.body.id } })
      ).quantity.toString(),
    ).toBe("12.5");

    const updated = await call(proposalLineRoute, "PUT", { id, lineId }, { quantity: "12.375" });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.quantity).toBe(12.375);

    const read = await call(proposalRoute, "GET", { id });
    expect(read.body.lineItems[0].quantity).toBe(12.375);
  });

  it("refuses a quantity that is not a number", async () => {
    const p = await proposal();
    const id = String(p.id);
    const line = await prisma.proposalLineItem.create({
      data: { proposalId: p.id, itemName: "Belgian Linen", cost: 8, retailPrice: 30 },
    });
    const lineId = String(line.id);

    const lots = await call(proposalLineRoute, "PUT", { id, lineId }, { quantity: "lots" });
    expect(lots.statusCode).toBe(400);
    expect(lots.body.error).toMatch(/quantity/i);
    expect((await call(proposalLineRoute, "PUT", { id, lineId }, { quantity: 0 })).statusCode).toBe(
      400,
    );
    const added = await call(
      proposalLinesRoute,
      "POST",
      { id },
      {
        itemName: "Belgian Linen",
        cost: 8,
        retailPrice: 30,
        quantity: "lots",
      },
    );
    expect(added.statusCode).toBe(400);
  });

  it("orders the part roll and prices the whole line when converted", async () => {
    const p = await proposal();
    await prisma.proposalLineItem.create({
      data: {
        proposalId: p.id,
        itemName: "Belgian Linen",
        cost: 8,
        retailPrice: 30,
        quantity: 12.5,
      },
    });

    const res = await call(convertRoute, "POST", { id: String(p.id) });
    expect(res.statusCode).toBe(201);
    const line = await prisma.orderLineItem.findFirstOrThrow({});
    expect(line.orderedQuantity.toString()).toBe("12.5");
    expect(Number(line.netPrice)).toBe(375);
    expect(Number(line.cost)).toBe(100);
  });
});
