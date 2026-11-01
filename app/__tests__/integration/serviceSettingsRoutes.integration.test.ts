// /app/__tests__/integration/serviceSettingsRoutes.integration.test.ts
//
// The service lookup lists -- case types, statuses, priorities -- answer in the
// shape every screen reads: { types }, { statuses }, { priorities }. They
// answered a bare list, so Service Settings showed none, the new-case form
// offered no type or priority, and the case page's status changer was empty
// (found 2026-11-01 with GAP-11).
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
import typesRoute from "@/pages/api/service/settings/types";
import statusesRoute from "@/pages/api/service/settings/statuses";
import prioritiesRoute from "@/pages/api/service/settings/priorities";

async function get(route: (req: NextApiRequest, res: NextApiResponse) => unknown) {
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
  const req = { method: "GET", query: {}, cookies: {}, headers: {} } as unknown as NextApiRequest;
  await route(req, res as unknown as NextApiResponse);
  return res;
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
  } as unknown as Session);
});

afterAll(async () => {
  await prisma.$disconnect();
});

it("each list answers under the key its screens read, in sort order", async () => {
  await prisma.serviceCaseType.createMany({
    data: [
      { name: "Repair", sortOrder: 1 },
      { name: "Warranty", sortOrder: 0 },
    ],
  });
  await prisma.serviceCaseStatus.create({ data: { name: "Open" } });
  await prisma.serviceCasePriority.create({ data: { name: "Normal" } });

  const types = await get(typesRoute);
  expect(types.statusCode).toBe(200);
  expect((types.body as { types: { name: string }[] }).types.map((t) => t.name)).toEqual([
    "Warranty",
    "Repair",
  ]);
  expect((await get(statusesRoute)).body).toEqual({
    statuses: [expect.objectContaining({ name: "Open" })],
  });
  expect((await get(prioritiesRoute)).body).toEqual({
    priorities: [expect.objectContaining({ name: "Normal" })],
  });
});
