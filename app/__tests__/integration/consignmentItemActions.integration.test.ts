// /app/__tests__/integration/consignmentItemActions.integration.test.ts
//
// What a consignment item's screen sends, each action through its real route.
//
// Found 2026-11-06 by clientApiRoutes.test.ts: every action button on the item page
// posted to /api/consignment/items/<id>/<action>, which is no route at all. The
// actions live at /api/consignment/items/<action> and take a list of item ids, and
// the page sent other names for what it did know (customerName, notes). "Mark
// Missing" and "Found - Return to Floor" had no route under those names, so they
// now go through the item's own PUT, which holds the transition rules.
//
// Real routes, real database; next-auth's session is the only mock.

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
import itemRoute from "@/pages/api/consignment/items/[id]";
import markApproval from "@/pages/api/consignment/items/mark-approval";
import markReturned from "@/pages/api/consignment/items/mark-returned";
import markSold from "@/pages/api/consignment/items/mark-sold";
import returnFromApproval from "@/pages/api/consignment/items/return-from-approval";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(route: Route, method: string, body: unknown, query = {}) {
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  const req = { method, body, query, cookies: {}, headers: {} };
  await route(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return { status, payload };
}

async function newRug(status: "ON_FLOOR" | "ON_APPROVAL" | "MISSING" | "SOLD" = "ON_FLOOR") {
  const vendor = await prisma.vendor.create({
    data: { name: `Consignor ${status}`, code: `C-${status}`, isConsignment: true },
  });
  return prisma.consignmentItem.create({
    data: { vendorId: vendor.id, barcode: `RUG-${status}`, cost: 100, status },
  });
}

const statusOf = async (id: number) =>
  (await prisma.consignmentItem.findUniqueOrThrow({ where: { id } })).status;

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.staffMember.create({
    data: {
      userId: "owner",
      email: "owner@example.com",
      displayName: "Owner",
      role: "ADMIN",
      roleId: role.id,
    },
  });
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: "owner", email: "owner@example.com" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("A consignment item's actions", () => {
  it("Send on Approval stores what the approval card then reads", async () => {
    const rug = await newRug();

    const sent = await call(markApproval, "POST", {
      itemIds: [rug.id],
      onApprovalCustomer: "Ada Lovelace",
      onApprovalNotes: "Trying it in the study",
    });
    expect(sent).toMatchObject({ status: 200, payload: { updated: 1 } });

    const read = await call(itemRoute, "GET", undefined, { id: String(rug.id) });
    expect(read.payload).toMatchObject({
      status: "ON_APPROVAL",
      onApprovalCustomer: "Ada Lovelace",
      onApprovalNotes: "Trying it in the study",
    });
    expect((read.payload as { onApprovalDate: unknown }).onApprovalDate).toBeTruthy();
  });

  it("Return to Floor takes an item off approval and clears who had it", async () => {
    const rug = await newRug("ON_APPROVAL");

    const sent = await call(returnFromApproval, "POST", { itemIds: [rug.id] });

    expect(sent.status).toBe(200);
    const after = await prisma.consignmentItem.findUniqueOrThrow({ where: { id: rug.id } });
    expect(after).toMatchObject({ status: "ON_FLOOR", onApprovalCustomer: null });
  });

  it("Mark Sold stores the customer and the day", async () => {
    const rug = await newRug();

    const sent = await call(markSold, "POST", {
      itemIds: [rug.id],
      saleCustomerName: "Ada Lovelace",
      saleDate: "2026-11-02",
    });
    expect(sent.status).toBe(200);

    const read = await call(itemRoute, "GET", undefined, { id: String(rug.id) });
    expect(read.payload).toMatchObject({ status: "SOLD", saleCustomerName: "Ada Lovelace" });
  });

  it("Return to Vendor sends the item back", async () => {
    const rug = await newRug();
    const sent = await call(markReturned, "POST", { itemIds: [rug.id] });
    expect(sent.status).toBe(200);
    expect(await statusOf(rug.id)).toBe("RETURNED_VENDOR");
  });

  it("Mark Missing, then Found, go through the item's own PUT", async () => {
    const rug = await newRug();
    const query = { id: String(rug.id) };

    expect((await call(itemRoute, "PUT", { status: "MISSING" }, query)).status).toBe(200);
    expect(await statusOf(rug.id)).toBe("MISSING");

    expect((await call(itemRoute, "PUT", { status: "ON_FLOOR" }, query)).status).toBe(200);
    expect(await statusOf(rug.id)).toBe("ON_FLOOR");
  });

  it("that PUT still refuses a move the transition rules don't allow", async () => {
    const rug = await newRug("SOLD");
    const refused = await call(itemRoute, "PUT", { status: "MISSING" }, { id: String(rug.id) });
    expect(refused.status).toBe(400);
    expect(await statusOf(rug.id)).toBe("SOLD");
  });
});
