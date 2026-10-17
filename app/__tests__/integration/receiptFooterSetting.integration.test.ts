// /app/__tests__/integration/receiptFooterSetting.integration.test.ts
//
// The receipt's returns note is the store's own setting.
//
// The thermal receipt printed "Returns within 7 days with receipt." from a
// literal, for every deployment. It now prints AppSettings.receiptFooter, set
// on Admin -> Settings through PUT /api/admin/settings, and nothing at all
// until a store writes one. Real route, real gate, real database; next-auth's
// session is the only mock.

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
import { getPublicBranding, invalidateAppSettingsCache } from "@/lib/appSettings";
import settingsRoute from "@/pages/api/admin/settings/index";

async function put(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const out = { status: 200, body: undefined as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: unknown) {
      out.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as NextApiResponse;
  const req = { method: "PUT", body, cookies: {}, query: {} } as unknown as NextApiRequest;
  await settingsRoute(req, res);
  return out;
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { id: 1, name: "Test Org", slug: "test-org" } });
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
  await prisma.staffMember.create({
    data: { userId: "owner", displayName: "Owner", role: "SUPER_ADMIN", roleId: role.id },
  });
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: "owner", email: "owner@example.com" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("AppSettings.receiptFooter", () => {
  it("is empty until the store writes one", async () => {
    expect((await getPublicBranding()).receiptFooter).toBeNull();
  });

  it("saves from Settings and reaches the receipt's branding", async () => {
    const out = await put({ receiptFooter: "  Returns within 30 days with receipt.  " });
    expect(out.status).toBe(200);
    expect(out.body.settings.receiptFooter).toBe("Returns within 30 days with receipt.");
    expect((await getPublicBranding()).receiptFooter).toBe("Returns within 30 days with receipt.");
  });

  it("clears back to nothing when emptied", async () => {
    await put({ receiptFooter: "Final sale." });
    const out = await put({ receiptFooter: "" });
    expect(out.status).toBe(200);
    expect((await getPublicBranding()).receiptFooter).toBeNull();
  });

  it("refuses a footer too long for a receipt", async () => {
    const out = await put({ receiptFooter: "x".repeat(241) });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/at most 240/);
  });
});
