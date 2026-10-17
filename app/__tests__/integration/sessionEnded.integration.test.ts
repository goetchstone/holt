// /app/__tests__/integration/sessionEnded.integration.test.ts
//
// A session whose user row is gone is signed out, not forbidden.
//
// A demo re-seed truncates User, and a browser still holding its session JWT
// got 403 from every gate: no menu, an empty dashboard, nothing saying why
// (local demo, 2026-10-17). Every gate now answers that session the way it
// answers no session -- 401 from an API route, UNAUTHORIZED from tRPC, a
// redirect to sign in from a page (lib/auth/sessionEnded.ts) -- while a user who
// exists but has no staff record keeps the 403 it always had.
//
// Real database; only the session readers (next-auth, next/headers) and
// redirect are mocked, as in roleListGates.integration.test.ts.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { requireAuthWithRole, requirePermission } from "@/lib/auth/requireAuth";
import { requirePage } from "@/lib/auth/requirePage";
import { SESSION_ENDED_MESSAGE } from "@/lib/auth/sessionEnded";
import {
  createCallerFactory,
  permissionProcedure,
  roleProcedure,
  router,
} from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";

async function callApi(
  gate: (h: () => Promise<void>) => (req: NextApiRequest, res: NextApiResponse) => unknown,
  userId: string,
): Promise<{ status: number; body: unknown }> {
  (getServerSession as jest.Mock).mockResolvedValue({ user: { id: userId } });
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: unknown) {
      out.body = payload;
      return this;
    },
  } as unknown as NextApiResponse;
  const req = { method: "GET", cookies: {} } as unknown as NextApiRequest;
  await gate(async () => {})(req, res);
  return out;
}

function ctxFor(userId: string): TrpcContext {
  return {
    userId,
    userEmail: `${userId}@example.com`,
    tokenRole: null,
    impersonate: null,
    headers: new Headers(),
  };
}

async function openPage(userId: string): Promise<string> {
  (getToken as jest.Mock).mockResolvedValue({ id: userId });
  (headers as jest.Mock).mockResolvedValue(new Headers());
  (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  try {
    await requirePage();
    return "rendered";
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("REDIRECT ")) return e.message;
    throw e;
  }
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
    },
  });
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a session whose user row is gone", () => {
  it("gets 401, not 403, from a permission-gated API route", async () => {
    const out = await callApi((h) => requirePermission("purchasing.read", h), "vanished");
    expect(out).toEqual({ status: 401, body: { error: SESSION_ENDED_MESSAGE } });
  });

  it("gets 401 from a role-list API route", async () => {
    const out = await callApi((h) => requireAuthWithRole(["ADMIN", "MANAGER"], h), "vanished");
    expect(out.status).toBe(401);
  });

  it("is UNAUTHORIZED, not FORBIDDEN, on tRPC", async () => {
    const probe = router({
      byPermission: permissionProcedure("reporting.read").query(() => "ok"),
      byRole: roleProcedure(["ADMIN"]).query(() => "ok"),
    });
    const caller = createCallerFactory(probe)(ctxFor("vanished"));
    await expect(caller.byPermission()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.byRole()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("is sent to sign in instead of being shown an empty app", async () => {
    await expect(openPage("vanished")).resolves.toBe("REDIRECT /auth/login");
  });
});

describe("a session whose user exists", () => {
  it("still gets 403 when it has no staff record", async () => {
    await prisma.user.create({ data: { id: "stranger", email: "stranger@example.com" } });
    const out = await callApi((h) => requirePermission("purchasing.read", h), "stranger");
    expect(out.status).toBe(403);
    await expect(openPage("stranger")).resolves.toBe("rendered");
  });

  it("is admitted as before when it holds the permission", async () => {
    const out = await callApi((h) => requirePermission("purchasing.read", h), "admin");
    expect(out.status).toBe(200);
    await expect(openPage("admin")).resolves.toBe("rendered");
  });
});
