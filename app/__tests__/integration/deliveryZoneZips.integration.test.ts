// /app/__tests__/integration/deliveryZoneZips.integration.test.ts
//
// What the delivery zone panel sends and reads, through the real routes.
//
// Found 2026-11-06: the page read `.zones` from an answer that is a bare list, so it
// said "No delivery zones configured" whatever was saved. Its panel read `.zips` from
// another bare list, sent `zips` where the route takes `zipCodes`, and read `.zone`
// from a zone. All of it compiled.
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
import zonesRoute from "@/pages/api/service/delivery-zones/index";
import zipsRoute from "@/pages/api/service/delivery-zones/[id]/zips";

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

describe("A delivery zone's ZIPs", () => {
  it("adds, lists, finds and removes by the names the panel sends and reads", async () => {
    const north = await prisma.deliveryZone.create({ data: { name: "North", baseFee: 50 } });
    const south = await prisma.deliveryZone.create({ data: { name: "South", baseFee: 75 } });
    await prisma.deliveryZoneZip.create({ data: { deliveryZoneId: south.id, zipCode: "60601" } });
    const query = { id: String(north.id) };

    const added = await call(zipsRoute, "POST", { zipCodes: ["60601", "60602", "nope"] }, query);
    expect(added).toMatchObject({
      status: 200,
      payload: { added: 1, reassigned: 1, invalid: ["nope"] },
    });

    const listed = await call(zipsRoute, "GET", undefined, query);
    expect((listed.payload as { zipCode: string }[]).map((row) => row.zipCode)).toEqual([
      "60601",
      "60602",
    ]);

    const found = await call(zonesRoute, "GET", undefined, { zipCode: "60602" });
    expect(found.payload).toMatchObject({ name: "North" });
    const none = await call(zonesRoute, "GET", undefined, { zipCode: "99999" });
    expect(none.payload).toBeNull();

    const removed = await call(zipsRoute, "DELETE", { zipCodes: ["60602"] }, query);
    expect(removed).toMatchObject({ status: 200, payload: { deleted: 1 } });

    // The page's list: a bare list, each zone counting its ZIPs.
    const zones = await call(zonesRoute, "GET", undefined);
    expect(zones.payload).toEqual([
      expect.objectContaining({ name: "North", _count: { zipCodes: 1 } }),
      expect.objectContaining({ name: "South", _count: { zipCodes: 0 } }),
    ]);
  });

  it("refuses a request that names no ZIPs", async () => {
    const zone = await prisma.deliveryZone.create({ data: { name: "North", baseFee: 50 } });
    const refused = await call(zipsRoute, "POST", { zips: ["60601"] }, { id: String(zone.id) });
    expect(refused.status).toBe(400);
  });
});
